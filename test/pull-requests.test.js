const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const PullRequest = require("../models/pullRequestModel");
const { createPullRequestController } = require("../controllers/pullRequestController");
const { buildMergedSnapshot, createMergeCommit } = require("../services/pullRequestService");

const repositoryId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const authorId = new mongoose.Types.ObjectId();

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function repository() {
  return {
    _id: repositoryId,
    owner: ownerId,
    defaultBranch: "main",
    visibility: "public",
    branches: [{ name: "main", head: "c1", isDefault: true }, { name: "feature", head: "f1", isDefault: false }],
    commits: [
      { hash: "c1", parent: null, parents: [], branch: "main", snapshot: [{ filename: "README.md", path: "README.md", hash: "a", s3Key: "readme" }] },
      { hash: "f1", parent: "c1", parents: ["c1"], branch: "feature", files: [{ filename: "feature.js", path: "src/feature.js", hash: "b", s3Key: "feature", status: "added" }] },
    ],
    content: [{ filename: "README.md", path: "README.md", hash: "a", s3Key: "readme" }],
    async save() { this.saved = true; },
  };
}

function comparison(overrides = {}) {
  return {
    files: [{ path: "src/feature.js", status: "added", additions: 1, deletions: 0, conflict: false }],
    commits: [{ hash: "f1", message: "Feature" }],
    summary: { filesChanged: 1, additions: 1, deletions: 0, hasConflicts: false, conflictCount: 0 },
    ancestryAvailable: true,
    ...overrides,
  };
}

function query(value) {
  return {
    populate() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function pull(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    repository: repositoryId,
    number: 1,
    title: "Feature",
    description: "",
    author: authorId,
    baseBranch: "main",
    compareBranch: "feature",
    status: "open",
    comments: [],
    async save() { this.saved = true; },
    toObject() { return { ...this, save: undefined, toObject: undefined }; },
    ...overrides,
  };
}

test("pull request schema validates required fields and repository-number uniqueness", async () => {
  const invalid = new PullRequest({});
  const error = invalid.validateSync();
  assert.ok(error.errors.repository);
  assert.ok(error.errors.number);
  assert.ok(error.errors.title);
  assert.ok(error.errors.author);
  assert.ok(PullRequest.schema.indexes().some(([fields, options]) => fields.repository === 1 && fields.number === 1 && options.unique));
});

test("create pull request validates title, branches, changes, duplicates, and atomic numbering", async () => {
  const repo = repository();
  let duplicate = null;
  let increment;
  const created = [];
  const PullModel = {
    findOne: async () => duplicate,
    create: async (value) => { const document = pull(value); created.push(document); return document; },
  };
  const RepoModel = {
    findOneAndUpdate: async (...args) => { increment = args; return { pullRequestCounter: 7 }; },
  };
  let compareResult = comparison();
  const controller = createPullRequestController({ PullModel, RepoModel, compare: async () => compareResult });
  const request = (body) => ({ repository: repo, user: { id: String(authorId) }, body });

  let res = response();
  await controller.create(request({ baseBranch: "main", compareBranch: "feature" }), res);
  assert.equal(res.statusCode, 400);
  res = response();
  await controller.create(request({ title: "Same", baseBranch: "main", compareBranch: "main" }), res);
  assert.equal(res.statusCode, 400);
  compareResult = comparison({ files: [], summary: { filesChanged: 0, additions: 0, deletions: 0, hasConflicts: false } });
  res = response();
  await controller.create(request({ title: "Empty", baseBranch: "main", compareBranch: "feature" }), res);
  assert.equal(res.statusCode, 400);
  compareResult = comparison();
  duplicate = { number: 3 };
  res = response();
  await controller.create(request({ title: "Duplicate", baseBranch: "main", compareBranch: "feature" }), res);
  assert.equal(res.statusCode, 409);
  duplicate = null;
  res = response();
  await controller.create(request({ title: "  Add feature  ", description: " text ", baseBranch: "main", compareBranch: "feature" }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(created[0].number, 7);
  assert.equal(created[0].title, "Add feature");
  assert.deepEqual(increment[1], { $inc: { pullRequestCounter: 1 } });
});

test("details recalculates comparison and lifecycle supports edit, close, and reopen authorization", async () => {
  const repo = repository();
  const document = pull();
  const PullModel = { findOne: () => query(document) };
  const controller = createPullRequestController({ PullModel, compare: async () => comparison() });
  let res = response();
  await controller.details({ repository: repo, params: { number: "1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mergeability.canMerge, true);
  res = response();
  await controller.update({ repository: repo, user: { id: String(authorId) }, params: { number: "1" }, body: { title: " Updated " } }, res);
  assert.equal(document.title, "Updated");
  res = response();
  await controller.close({ repository: repo, user: { id: String(authorId) }, params: { number: "1" } }, res);
  assert.equal(document.status, "closed");
  res = response();
  await controller.reopen({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" } }, res);
  assert.equal(document.status, "open");
  res = response();
  await controller.update({ repository: repo, user: { id: String(new mongoose.Types.ObjectId()) }, params: { number: "1" }, body: { title: "Denied" } }, res);
  assert.equal(res.statusCode, 403);
});

test("merge snapshot preserves base files, applies compare changes, and records a merge commit", () => {
  const repo = repository();
  const merged = buildMergedSnapshot(repo, "main", "feature");
  assert.deepEqual(merged.files.map((file) => file.path).sort(), ["README.md", "src/feature.js"]);
  const pr = pull();
  const result = createMergeCommit(repo, pr, comparison(), String(ownerId));
  assert.equal(repo.branches[0].head, result.hash);
  assert.equal(repo.commits.at(-1).parent, "c1");
  assert.deepEqual(repo.commits.at(-1).snapshot.map((file) => file.path).sort(), ["README.md", "src/feature.js"]);
});

test("merge controller rejects conflicts and closed PRs, then merges an open PR", async () => {
  const repo = repository();
  const document = pull();
  const PullModel = { findOne: () => query(document) };
  let result = comparison({ summary: { filesChanged: 1, additions: 1, deletions: 0, hasConflicts: true }, files: [{ path: "x", conflict: true }] });
  const controller = createPullRequestController({ PullModel, compare: async () => result });
  let res = response();
  await controller.merge({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflicts.length, 1);
  document.status = "closed";
  res = response();
  await controller.merge({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" } }, res);
  assert.equal(res.statusCode, 409);
  document.status = "open";
  result = comparison();
  res = response();
  await controller.merge({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(document.status, "merged");
  assert.ok(document.mergeCommit);
});

test("pull request routes are registered before the generic repository route", () => {
  const router = require("../routes/repo.router");
  const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean);
  const generic = paths.indexOf("/:id");
  for (const path of ["/:id/pulls", "/:id/pulls/:number", "/:id/pulls/:number/comments", "/:id/pulls/:number/merge", "/:id/pulls/:number/close", "/:id/pulls/:number/reopen"]) {
    assert.ok(paths.includes(path));
    assert.ok(paths.indexOf(path) < generic);
  }
});
