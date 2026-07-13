const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryId = "507f1f77bcf86cd799439011";
let repository;
const uploads = [];

const modelModule = require.resolve("../models/repoModel");
require.cache[modelModule] = { exports: { findById: async () => repository } };
const awsModule = require.resolve("../config/aws-config");
require.cache[awsModule] = {
  exports: {
    S3_BUCKET: "test-bucket",
    s3: {
      upload(params) {
        uploads.push(params.Key);
        return {
          promise: () => new Promise((resolve, reject) => {
            params.Body.on("error", reject);
            params.Body.on("end", resolve);
            params.Body.resume();
          }),
        };
      },
    },
  },
};
const { pushRepo } = require("../controllers/push");

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function writeCommit(root, storageId, files) {
  const commitRoot = path.join(root, ".myGit", repositoryId, "commits", storageId);
  for (const [filePath, content] of Object.entries(files)) {
    const destination = path.join(commitRoot, ...filePath.split("/"));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, content);
  }
  await fsp.writeFile(path.join(commitRoot, "commit.json"), JSON.stringify({ time: new Date().toISOString() }));
}

async function runPush(paths, branch, head) {
  const res = response();
  await pushRepo({ params: { id: repositoryId }, body: { paths, branch, head } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

test("push uploads the first snapshot, skips an immediate repeat, then uploads exactly one modification", async (t) => {
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codehub-push-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  process.chdir(root);
  const firstHash = "a".repeat(64);
  repository = {
    content: [],
    commits: [{ _id: "commit-1", hash: firstHash, storageId: "storage-1", parent: null, files: [], snapshot: [] }],
    branches: [{ name: "main", head: firstHash, isDefault: true }],
    async save() {},
  };
  await writeCommit(root, "storage-1", { "src/App.jsx": "one", "README.md": "readme" });

  // Browser pushes do not send an explicit head; the commit is resolved by storageId.
  let result = await runPush(["src/App.jsx", "README.md"], "main");
  assert.equal(result.uploadedCount, 2);
  assert.equal(result.skippedCount, 0);
  assert.equal(repository.commits[0].snapshot.length, 2);

  uploads.length = 0;
  result = await runPush(["src/App.jsx", "README.md"], "main", firstHash);
  assert.equal(result.uploadedCount, 0);
  assert.equal(result.skippedCount, 2);
  assert.equal(uploads.length, 0);

  const secondHash = "b".repeat(64);
  repository.commits.push({
    _id: "commit-2",
    hash: secondHash,
    storageId: "storage-2",
    parent: firstHash,
    parents: [firstHash],
    files: [],
    snapshot: [],
  });
  repository.branches[0].head = secondHash;
  await writeCommit(root, "storage-2", { "src/App.jsx": "two", "README.md": "readme" });
  uploads.length = 0;
  result = await runPush(["src/App.jsx", "README.md"], "main", secondHash);
  assert.equal(result.uploadedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(result.uploaded, ["src/App.jsx"]);
});
