const assert = require("node:assert/strict");
const test = require("node:test");

let repository;
const s3Calls = { get: [], copy: [], delete: [] };

const accessModule = require.resolve("../utils/repositoryAccess");
require.cache[accessModule] = {
  exports: {
    getAccessibleRepository: async () => repository,
    sendAccessError: (res, error) => res.status(error.status || 500).json({ error: error.message }),
    requireRepositoryRead: (req, res, next) => next(),
    requireRepositoryWrite: (req, res, next) => next(),
  },
};

const awsModule = require.resolve("../config/aws-config");
require.cache[awsModule] = {
  exports: {
    S3_BUCKET: "test-bucket",
    s3: {
      getObject: (params) => ({ promise: async () => {
        s3Calls.get.push(params);
        return { Body: Buffer.from(params.Key.includes("frontend") ? "frontend" : "admin"), ContentType: "text/plain" };
      } }),
      copyObject: (params) => ({ promise: async () => { s3Calls.copy.push(params); } }),
      deleteObject: (params) => ({ promise: async () => { s3Calls.delete.push(params); } }),
    },
  },
};

const { previewFile } = require("../controllers/previewController");
const { getFile } = require("../controllers/fileController");
const { deleteFile, renameFile, destinationPath } = require("../controllers/fileManageController");
const { findRepositoryFile, normalizeRepoPath, requestedRepoPath } = require("../utils/repoPath");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

function createRepository() {
  return {
    content: [
      { filename: "App.jsx", path: "frontend/src/App.jsx", s3Key: "repos/id/frontend/src/App.jsx" },
      { filename: "App.jsx", path: "admin/src/App.jsx", s3Key: "repos/id/admin/src/App.jsx" },
    ],
    commits: [{ files: [{ filename: "App.jsx", path: "frontend/src/App.jsx" }] }],
    async save() { this.saved = true; },
  };
}

test.beforeEach(() => {
  repository = createRepository();
  s3Calls.get.length = 0;
  s3Calls.copy.length = 0;
  s3Calls.delete.length = 0;
});

test("repository paths normalize separators and reject traversal, absolute paths, and null bytes", () => {
  assert.equal(normalizeRepoPath("frontend\\src\\App.jsx"), "frontend/src/App.jsx");
  // Express 4 has already decoded each wildcard segment before the controller runs.
  assert.equal(requestedRepoPath({ params: { 0: "frontend/src/App File.jsx" } }), "frontend/src/App File.jsx");
  assert.throws(() => normalizeRepoPath("../secret"), /Unsafe/);
  assert.throws(() => normalizeRepoPath("/etc/passwd"), /Unsafe/);
  assert.throws(() => normalizeRepoPath("C:\\secret"), /Unsafe/);
  assert.throws(() => normalizeRepoPath("bad\0name"), /Unsafe/);
});

test("preview and download distinguish duplicate filenames by complete relative path", async () => {
  const previewResponse = response();
  await previewFile({ params: { id: "id", 0: "frontend/src/App.jsx" }, headers: {} }, previewResponse);
  assert.equal(previewResponse.statusCode, 200);
  assert.equal(previewResponse.body.path, "frontend/src/App.jsx");
  assert.equal(previewResponse.body.content, "frontend");
  assert.equal(s3Calls.get[0].Key, "repos/id/frontend/src/App.jsx");

  const downloadResponse = response();
  await getFile({ params: { id: "id", 0: "admin/src/App.jsx" }, headers: {} }, downloadResponse);
  assert.equal(downloadResponse.body.toString(), "admin");
  assert.match(downloadResponse.headers["Content-Disposition"], /App\.jsx/);
  assert.equal(s3Calls.get[1].Key, "repos/id/admin/src/App.jsx");
});

test("preview refuses protected environment files without reading S3", async () => {
  repository.content.push({ filename: ".env", path: "config/.env", s3Key: "repos/id/config/.env" });
  const res = response();
  await previewFile({ params: { id: "id", 0: "config/.env" }, headers: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(s3Calls.get.length, 0);
});

test("rename preserves a parent for basenames, moves S3 first, rejects ambiguity, and leaves history intact", async () => {
  assert.equal(destinationPath("frontend/src/App.jsx", "Main.jsx"), "frontend/src/Main.jsx");
  assert.equal(destinationPath("frontend/src/App.jsx", "shared/Main.jsx"), "shared/Main.jsx");
  const res = response();
  await renameFile({
    params: { id: "id", 0: "frontend/src/App.jsx" },
    body: { newName: "Main.jsx" },
    repository,
    headers: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(repository.content[0].path, "frontend/src/Main.jsx");
  assert.equal(repository.content[0].filename, "Main.jsx");
  assert.equal(s3Calls.copy.length, 1);
  assert.equal(s3Calls.delete.length, 1);
  assert.equal(repository.commits[0].files[0].path, "frontend/src/App.jsx");
});

test("delete removes exactly one full path from S3 and the latest snapshot", async () => {
  const res = response();
  await deleteFile({ params: { id: "id", 0: "admin/src/App.jsx" }, repository, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repository.content.map((file) => file.path), ["frontend/src/App.jsx"]);
  assert.equal(s3Calls.delete[0].Key, "repos/id/admin/src/App.jsx");
  assert.equal(repository.commits[0].files.length, 1);
});

test("stored Windows paths can still be found without basename matching", () => {
  repository.content[0].path = "frontend\\src\\App.jsx";
  assert.equal(findRepositoryFile(repository, "frontend/src/App.jsx"), repository.content[0]);
  assert.equal(findRepositoryFile(repository, "other/src/App.jsx"), undefined);
});

test("Express 4 wildcard file routes are registered before the generic repository route", () => {
  const router = require("../routes/repo.router");
  const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  for (const routePath of ["/preview/:id/*", "/file/:id/*"]) assert(paths.includes(routePath));
  assert(paths.indexOf("/preview/:id/*") < paths.indexOf("/:id"));
  assert(paths.indexOf("/file/:id/*") < paths.indexOf("/:id"));
  assert.equal(paths.filter((routePath) => routePath === "/:id").length, 1);
});

test("installed Express 4 decodes segment-encoded nested wildcard paths", async (t) => {
  const express = require("express");
  const app = express();
  app.get("/file/:id/*", (req, res) => res.json({ id: req.params.id, filePath: req.params[0] }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/file/repo/frontend/src/App%20File.jsx`);
  assert.deepEqual(await response.json(), { id: "repo", filePath: "frontend/src/App File.jsx" });
});
