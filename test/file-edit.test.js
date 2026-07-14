const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createFileEditController, MAX_EDIT_BYTES, isEditablePath } = require("../controllers/fileEditController");

const owner = "507f1f77bcf86cd799439011";
const oldBody = Buffer.from("old\n");
const oldHash = crypto.createHash("sha256").update(oldBody).digest("hex");
const makeRepository = () => ({
  _id: "507f1f77bcf86cd799439012", name: "demo", owner, visibility: "public", watchers: [], defaultBranch: "main",
  branches: [{ name: "main", head: "c1", isDefault: true }, { name: "feature", head: "c1", isDefault: false }],
  commits: [{ hash: "c1", parent: null, parents: [], branch: "main", snapshot: [
    { filename: "app.js", path: "src/app.js", hash: oldHash, s3Key: "old/app.js", size: oldBody.length, contentType: "text/javascript" },
    { filename: "keep.txt", path: "keep.txt", hash: "keep", s3Key: "old/keep.txt", size: 4, contentType: "text/plain" },
  ], files: [], time: new Date() }],
  content: [],
  async save() { this.saved = true; },
});
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = (repository, body = {}) => ({ params: { id: String(repository._id) }, body, query: {}, user: { id: owner }, repository });
const dependencies = (repository, overrides = {}) => ({
  RepoModel: { findById: async () => repository },
  UserModel: { findById: () => ({ select: async () => ({ username: "owner", email: "owner@example.com" }) }) },
  storage: {
    getObject: () => ({ promise: async () => ({ Body: oldBody, ContentType: "text/javascript" }) }),
    putObject: (input) => ({ promise: async () => { repository.put = input; } }),
  },
  bucket: "bucket",
  notify: async () => [],
  ...overrides,
});

test("editable path rules allow safe source formats and reject binary/protected files", () => {
  for (const value of ["README.md", "src/a.tsx", "config/app.properties", ".gitignore", ".env.example"]) assert.equal(isEditablePath(value), true);
  for (const value of ["image.png", "document.pdf", ".env", "keys/app.pem", "service-account.json"]) assert.equal(isEditablePath(value), false);
});

test("editing a nested text file creates a normal branch commit and preserves the full parent snapshot", async () => {
  const repository = makeRepository();
  const controller = createFileEditController(dependencies(repository));
  const req = request(repository, { path: "src/app.js", branch: "main", content: "new\n", commitMessage: "Update app", baseCommit: "c1" });
  const res = response(); await controller.update(req, res);
  assert.equal(res.statusCode, 200); assert.equal(repository.saved, true);
  const commit = repository.commits.at(-1);
  assert.equal(commit.parent, "c1"); assert.deepEqual(commit.parents, ["c1"]); assert.equal(commit.files[0].status, "modified");
  assert.equal(commit.snapshot.length, 2); assert.equal(commit.snapshot.find((file) => file.path === "keep.txt").s3Key, "old/keep.txt");
  assert.match(repository.put.Key, /\/commits\/[^/]+\/src\/app\.js$/); assert.notEqual(repository.put.Key, "old/app.js");
  assert.equal(repository.branches[0].head, commit.hash); assert.equal(res.body.commit.hash, commit.hash);
});

test("owner edits to a fork succeed and remain isolated to that fork", async () => {
  const fork = makeRepository(); fork.forkedFrom = "507f1f77bcf86cd799439099";
  const controller = createFileEditController(dependencies(fork)); const res = response();
  await controller.update(request(fork, { path: "src/app.js", branch: "feature", content: "fork change", commitMessage: "Fork edit", baseCommit: "c1" }), res);
  assert.equal(res.statusCode, 200); assert.equal(fork.branches[1].head, res.body.commit.hash); assert.equal(fork.forkedFrom, "507f1f77bcf86cd799439099");
});

test("stale base commits are rejected without an S3 write", async () => {
  const repository = makeRepository(); const controller = createFileEditController(dependencies(repository)); const res = response();
  await controller.update(request(repository, { path: "src/app.js", branch: "main", content: "new", commitMessage: "Edit", baseCommit: "older" }), res);
  assert.equal(res.statusCode, 409); assert.match(res.body.error, /changed after/); assert.equal(repository.put, undefined);
});

test("large submissions are rejected before repository or storage access", async () => {
  const repository = makeRepository(); const controller = createFileEditController(dependencies(repository)); const res = response();
  await controller.update(request(repository, { path: "src/app.js", branch: "main", content: "x".repeat(MAX_EDIT_BYTES + 1), commitMessage: "Edit", baseCommit: "c1" }), res);
  assert.equal(res.statusCode, 413); assert.equal(repository.put, undefined);
});

for (const [name, body, status] of [
  ["unsupported binary file", { path: "image.png", branch: "main", content: "data", commitMessage: "Edit", baseCommit: "c1" }, 415],
  ["protected file", { path: ".env", branch: "main", content: "secret", commitMessage: "Edit", baseCommit: "c1" }, 403],
  ["path traversal", { path: "../app.js", branch: "main", content: "data", commitMessage: "Edit", baseCommit: "c1" }, 400],
  ["missing file", { path: "missing.js", branch: "main", content: "data", commitMessage: "Edit", baseCommit: "c1" }, 404],
  ["invalid branch", { path: "src/app.js", branch: "missing", content: "data", commitMessage: "Edit", baseCommit: "c1" }, 404],
]) test(`${name} is rejected`, async () => {
  const repository = makeRepository(); const controller = createFileEditController(dependencies(repository)); const res = response();
  await controller.update(request(repository, body), res); assert.equal(res.statusCode, status);
});

test("editor read returns content and the current base commit", async () => {
  const repository = makeRepository(); const controller = createFileEditController(dependencies(repository)); const res = response();
  const req = request(repository); req.query = { path: "src/app.js", branch: "main" }; await controller.read(req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.content, "old\n"); assert.equal(res.body.baseCommit, "c1");
});

test("file editor routes require repository write access and precede repository details", () => {
  const stack = require("../routes/repo.router").stack.filter((layer) => layer.route);
  const routes = stack.map((layer) => layer.route.path); const index = routes.indexOf("/:id/file-editor");
  assert.ok(index > -1 && index < routes.indexOf("/:id"));
  assert.ok(stack[index].route.stack.length >= 2);
});
