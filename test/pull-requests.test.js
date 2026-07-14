const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const PullRequest = require("../models/pullRequestModel");
const { createPullRequestController } = require("../controllers/pullRequestController");
const { buildMergedSnapshot, createMergeCommit, reviewSummary } = require("../services/pullRequestService");

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
    base: { name: "main", head: "c1" },
    compare: { name: "feature", head: "f1" },
    mergeBase: "c1",
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
    reviews: [],
    async save() { this.saved = true; },
    async populate() { return this; },
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
  assert.equal(created[0].baseHeadAtCreation, "c1");
  assert.equal(created[0].compareHeadAtCreation, "f1");
  assert.equal(created[0].mergeBaseAtCreation, "c1");
  assert.deepEqual(created[0].commitIds, ["f1"]);
  assert.equal(created[0].changedFilesSnapshot[0].path, "src/feature.js");
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
  assert.equal(document.finalBaseHead, "c1");
  assert.equal(document.finalCompareHead, "f1");
  assert.deepEqual(document.finalCommitIds, ["f1"]);
  assert.equal(document.finalChangedFilesSnapshot.length, 1);
});

test("details returns safe identities and a merged historical comparison", async () => {
  const repo = repository();
  const user = { _id: authorId, username: "puskar", name: "Puskar Porel", avatarUrl: "" };
  const document = pull({
    author: user,
    mergedBy: user,
    comments: [{ _id: "comment-1", body: "Nice", author: user, createdAt: new Date() }],
    status: "merged",
    finalBaseHead: "c1",
    finalCompareHead: "f1",
    finalMergeBase: "c1",
    finalCommitIds: ["f1"],
    finalChangedFilesSummary: { filesChanged: 1, additions: 1, deletions: 0 },
    finalChangedFilesSnapshot: [{ path: "src/feature.js", status: "added", additions: 1, deletions: 0 }],
  });
  const controller = createPullRequestController({ PullModel: { findOne: () => query(document) } });
  const res = response();
  await controller.details({ repository: repo, params: { number: "1" } }, res);
  assert.equal(res.body.pullRequest.author.username, "puskar");
  assert.equal(res.body.pullRequest.comments[0].author.name, "Puskar Porel");
  assert.equal(res.body.comparisonSource, "merge_snapshot");
  assert.equal(res.body.comparison.commits.length, 1);
  assert.equal(res.body.comparison.files.length, 1);
});

test("review decisions validate permissions and latest decisions control merge blocking", async () => {
  const repo = repository();
  const document = pull();
  const controller = createPullRequestController({ PullModel: { findOne: () => query(document) }, compare: async () => comparison() });
  let res = response();
  await controller.review({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" }, body: { decision: "changes_requested", body: "Please fix it" } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.review.decision, "changes_requested");
  res = response();
  await controller.merge({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "Merge blocked by requested changes");
  res = response();
  await controller.review({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" }, body: { decision: "approved", body: "Ready" } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.reviewSummary.blocking, false);
  res = response();
  await controller.merge({ repository: repo, user: { id: String(ownerId) }, params: { number: "1" } }, res);
  assert.equal(res.statusCode, 200);
});

test("reviews reject missing bodies, self approval, non-owner decisions, and closed PRs", async () => {
  const repo = repository();
  const document = pull();
  const controller = createPullRequestController({ PullModel: { findOne: () => query(document) } });
  const submit = async (userId, decision, body) => {
    const res = response();
    await controller.review({ repository: repo, user: { id: String(userId) }, params: { number: "1" }, body: { decision, body } }, res);
    return res;
  };
  assert.equal((await submit(ownerId, "commented", "")).statusCode, 400);
  assert.equal((await submit(authorId, "approved", "")).statusCode, 403);
  assert.equal((await submit(new mongoose.Types.ObjectId(), "changes_requested", "Fix")).statusCode, 403);
  assert.equal((await submit(authorId, "commented", "A note")).statusCode, 201);
  document.status = "closed";
  assert.equal((await submit(ownerId, "commented", "Late")).statusCode, 409);
  document.status = "merged";
  assert.equal((await submit(ownerId, "commented", "Later")).statusCode, 409);
});

test("review summary uses latest reviewer decision and makes approvals stale after new commits", () => {
  const reviewer = { _id: ownerId, username: "owner" };
  const summary = reviewSummary([
    { _id: "a", reviewer, decision: "changes_requested", commitHead: "f1", createdAt: new Date(1) },
    { _id: "b", reviewer, decision: "approved", commitHead: "f1", createdAt: new Date(2) },
  ], "f2");
  assert.equal(summary.blocking, false);
  assert.equal(summary.approved, 0);
  assert.equal(summary.latestByReviewer[0].stale, true);
});

test("pull request routes are registered before the generic repository route", () => {
  const router = require("../routes/repo.router");
  const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean);
  const generic = paths.indexOf("/:id");
  for (const path of ["/:id/pulls", "/:id/pulls/:number", "/:id/pulls/:number/comments", "/:id/pulls/:number/reviews", "/:id/pulls/:number/merge", "/:id/pulls/:number/close", "/:id/pulls/:number/reopen"]) {
    assert.ok(paths.includes(path));
    assert.ok(paths.indexOf(path) < generic);
  }
});
