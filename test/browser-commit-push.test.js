const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repositoryId = "507f1f77bcf86cd799439012";
const ownerId = "507f1f77bcf86cd799439011";
let repository;
let failUpload = false;

const modelModule = require.resolve("../models/repoModel");
require.cache[modelModule] = { exports: { findById: async () => repository } };
const userModule = require.resolve("../models/userModel");
require.cache[userModule] = { exports: { findById: () => ({ select: async () => ({ _id: ownerId, username: "Puskar", name: "Puskar Dey", email: "puskar@example.com" }) }) } };
const awsModule = require.resolve("../config/aws-config");
require.cache[awsModule] = { exports: { S3_BUCKET: "test-bucket", s3: { upload(params) { return { promise: () => new Promise((resolve, reject) => {
  if (failUpload) { reject(new Error("storage unavailable")); return; }
  params.Body.on("error", reject); params.Body.on("end", resolve); params.Body.resume();
}) }; } } } };
for (const [modulePath, exports] of [
  ["../services/notificationService", { safeNotifyRepositoryWatchers: async () => [] }],
  ["../services/reviewNotificationService", { notifyReviewersOfNewHead: async () => [] }],
  ["../services/workflowEventService", { safeScheduleCommitWorkflows: async () => [] }],
]) require.cache[require.resolve(modulePath)] = { exports };

const { commitRepo } = require("../controllers/commit");
const { pushRepo } = require("../controllers/push");
const { getBrowserStatus } = require("../controllers/browserStatusController");
const { stagingPath } = require("../utils/browserWorkflow");

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function makeRepository() {
  return {
    _id: repositoryId, name: "test-33", owner: ownerId, visibility: "private", collaborators: [],
    defaultBranch: "main", branches: [{ name: "main", head: "remote-1", isDefault: true }],
    commits: [{ hash: "remote-1", parent: null, branch: "main", snapshot: [], files: [], author: { name: "Puskar" } }],
    pendingCommits: [], content: [], branchProtections: [], watchers: [],
    async save() { this.saved = true; },
  };
}

async function status() {
  const res = response();
  await getBrowserStatus({ params: { branchName: "main" }, query: {}, user: { id: ownerId }, repository }, res);
  assert.equal(res.statusCode, 200);
  return res.body;
}

test("browser Commit persists an authenticated pending commit and Push alone advances the remote head", async (t) => {
  const oldCwd = process.cwd(); const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codehub-browser-flow-"));
  process.chdir(root); t.after(async () => { process.chdir(oldCwd); await fsp.rm(root, { recursive: true, force: true }); });
  repository = makeRepository();
  const stagedRoot = stagingPath(repositoryId, ownerId, "main");
  await fsp.mkdir(stagedRoot, { recursive: true }); await fsp.writeFile(path.join(stagedRoot, "new.txt"), "new file\n");
  assert.equal((await status()).hasStagedChanges, true);

  const commit = await commitRepo(repositoryId, "Add new file", { branch: "main", authenticatedUserId: ownerId });
  assert.equal(repository.branches[0].head, "remote-1");
  assert.equal(repository.commits.length, 1);
  assert.equal(repository.pendingCommits.length, 1);
  assert.equal(repository.pendingCommits[0].author.username, "Puskar");
  assert.equal(repository.pendingCommits[0].author.user, ownerId);
  assert.equal(commit.aheadCount, 1); assert.equal(commit.hasUnpushedCommits, true);
  assert.equal((await status()).hasStagedChanges, false);
  assert.equal((await status()).aheadCount, 1);

  const pushResponse = response();
  await pushRepo({ params: { id: repositoryId }, body: { branch: "main" }, user: { id: ownerId } }, pushResponse);
  assert.equal(pushResponse.statusCode, 200, JSON.stringify(pushResponse.body));
  assert.equal(pushResponse.body.aheadCount, 0);
  assert.equal(repository.branches[0].head, commit.hash);
  assert.equal(repository.commits.length, 2);
  assert.equal(repository.commits[1].author.username, "Puskar");
  assert.ok(repository.pendingCommits[0].pushedAt);
  assert.equal((await status()).aheadCount, 0);
});

test("a failed browser Push leaves the pending commit retryable", async (t) => {
  const oldCwd = process.cwd(); const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codehub-browser-fail-"));
  process.chdir(root); t.after(async () => { failUpload = false; process.chdir(oldCwd); await fsp.rm(root, { recursive: true, force: true }); });
  repository = makeRepository();
  const stagedRoot = stagingPath(repositoryId, ownerId, "main");
  await fsp.mkdir(stagedRoot, { recursive: true }); await fsp.writeFile(path.join(stagedRoot, "retry.txt"), "retry\n");
  await commitRepo(repositoryId, "Retry me", { branch: "main", authenticatedUserId: ownerId });
  failUpload = true;
  const res = response(); await pushRepo({ params: { id: repositoryId }, body: { branch: "main" }, user: { id: ownerId } }, res);
  assert.equal(res.statusCode, 500); assert.equal(repository.branches[0].head, "remote-1");
  assert.equal(repository.pendingCommits[0].pushedAt, null);
  assert.equal((await status()).aheadCount, 1);
});
