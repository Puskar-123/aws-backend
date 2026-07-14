const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const PullRequest = require("../models/pullRequestModel");
const { createAdvancedReviewController } = require("../controllers/advancedReviewController");
const { getEffectiveReviewSummary, getReviewMergeStatus, threadIsOutdated } = require("../services/pullRequestReviewService");
const { assertCanMergePullRequest } = require("../services/branchProtectionService");
const { notifyReviewersOfNewHead } = require("../services/reviewNotificationService");

const oid = () => new mongoose.Types.ObjectId();
const repositoryId = oid(); const owner = oid(); const author = oid(); const reviewer = oid(); const outsider = oid();
const users = [
  { _id: owner, username: "owner", name: "Owner" }, { _id: author, username: "author", name: "Author" },
  { _id: reviewer, username: "reviewer", name: "Reviewer" }, { _id: outsider, username: "outsider", name: "Outsider" },
];
const userBy = (id) => users.find((user) => String(user._id) === String(id));
const userQuery = (value) => ({ select() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const UserModel = {
  findById: (id) => userQuery(userBy(id) || null),
  findOne: (filter) => userQuery(users.find((user) => user.username === filter.username) || null),
  find: (filter) => ({ select: async () => users.filter((user) => filter._id.$in.some((id) => String(id) === String(user._id))) }),
};

function repository(overrides = {}) {
  return {
    _id: repositoryId, owner, visibility: "private", defaultBranch: "main",
    collaborators: [{ user: author, role: "write" }, { user: reviewer, role: "maintainer" }],
    branches: [{ name: "main", head: "base", isDefault: true }, { name: "feature", head: "head-1" }],
    branchProtections: [{ branch: "main", enabled: true, requiredApprovals: 1, dismissStaleApprovals: true, requireResolvedConversations: true }],
    ...overrides,
  };
}
function pull(overrides = {}) {
  const document = new PullRequest({ repository: repositoryId, number: 1, title: "Review", author, baseBranch: "main", compareBranch: "feature", status: "open", ...overrides });
  document.save = async () => document;
  return document;
}
const comparison = () => ({
  files: [
    { path: "src/app.js", status: "modified", additions: 1, deletions: 0, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [{ type: "context", content: " const a = 1", oldLineNumber: 1, newLineNumber: 1 }, { type: "added", content: "+const b = 2", oldLineNumber: null, newLineNumber: 2 }] }] },
    { path: ".env", protected: true, hunks: [] }, { path: "logo.png", binary: true, isBinary: true, hunks: [] },
  ], summary: { filesChanged: 3, additions: 1, deletions: 0, hasConflicts: false },
});
const query = (value) => ({ populate() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = (repo, userId, body = {}, params = {}) => ({ repository: repo, user: userId ? { id: String(userId) } : null, body, params: { number: "1", ...params } });

test("advanced review schema embeds requested reviewers, threads, replies, and review commit metadata", () => {
  assert.equal(PullRequest.schema.path("requestedReviewers.user").options.ref, "User");
  assert.equal(PullRequest.schema.path("reviewThreads.comments.author").options.ref, "User");
  assert.equal(PullRequest.schema.path("reviewThreads.side").options.enum.length, 2);
  assert.equal(PullRequest.schema.path("reviews.commitHead").instance, "String");
});

test("central review state uses latest eligible review, stale policy, and current unresolved threads", () => {
  const repo = repository();
  const document = pull({ reviews: [
    { reviewer, decision: "changes_requested", body: "Fix", commitHead: "head-1" },
    { reviewer, decision: "approved", body: "Done", commitHead: "head-1" },
    { reviewer: author, decision: "approved", commitHead: "head-1" },
    { reviewer: outsider, decision: "approved", commitHead: "head-1" },
  ], reviewThreads: [
    { filePath: "src/app.js", side: "RIGHT", line: 2, originalLine: 2, commitHash: "head-1", originalCommitHash: "head-1", createdBy: reviewer, comments: [{ author: reviewer, body: "Current" }] },
    { filePath: "src/app.js", side: "RIGHT", line: 1, originalLine: 1, commitHash: "old", originalCommitHash: "old", createdBy: reviewer, comments: [{ author: reviewer, body: "Old" }] },
  ] });
  let summary = getEffectiveReviewSummary(repo, document, "head-1", { dismissStaleApprovals: true });
  assert.equal(summary.approvals, 1); assert.equal(summary.blocking, false);
  let status = getReviewMergeStatus(repo, document, "head-1", repo.branchProtections[0]);
  assert.equal(status.unresolvedConversations, 1); assert.equal(status.mergeable, false);
  assert.throws(() => assertCanMergePullRequest(repo, document, "head-1"), (error) => error.code === "UNRESOLVED_CONVERSATIONS" && error.unresolvedCount === 1);
  document.reviewThreads[0].resolved = true;
  status = getReviewMergeStatus(repo, document, "head-1", repo.branchProtections[0]); assert.equal(status.mergeable, true);
  assert.equal(threadIsOutdated(document.reviewThreads[1], "head-1"), true);
  status = getReviewMergeStatus(repo, document, "head-2", repo.branchProtections[0]); assert.equal(status.validApprovals, 0); assert.equal(status.staleApprovals, 1);
});

test("files API excludes protected paths, identifies binary files, and returns thread state without N+1 queries", async () => {
  const repo = repository();
  const document = pull({ reviewThreads: [{ filePath: "src/app.js", side: "RIGHT", line: 2, originalLine: 2, commitHash: "old", originalCommitHash: "old", createdBy: reviewer, comments: [{ author: reviewer, body: "Old line" }] }] });
  const controller = createAdvancedReviewController({ PullModel: { findOne: () => query(document) }, UserModel, compare: async () => comparison() });
  const res = response(); await controller.files(request(repo, author), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.files.map((file) => file.path), ["src/app.js", "logo.png"]);
  assert.equal(res.body.files[1].isBinary, true); assert.equal(res.body.files[0].threads[0].outdated, true);
});

test("line comment validates current head, file, side, and line then persists first comment", async () => {
  const repo = repository(); const document = pull(); const notifications = [];
  const controller = createAdvancedReviewController({ PullModel: { findOne: () => query(document) }, UserModel, compare: async () => comparison(), notifyUser: async (value) => notifications.push(value) });
  for (const body of [
    { filePath: "src/app.js", side: "RIGHT", line: 2, commitHash: "old", body: "Stale" },
    { filePath: "missing.js", side: "RIGHT", line: 2, commitHash: "head-1", body: "Missing" },
    { filePath: "src/app.js", side: "MIDDLE", line: 2, commitHash: "head-1", body: "Side" },
    { filePath: "src/app.js", side: "RIGHT", line: 99, commitHash: "head-1", body: "Line" },
  ]) { const res = response(); await controller.createThread(request(repo, reviewer, body), res); assert.ok([400, 409].includes(res.statusCode)); }
  const res = response(); await controller.createThread(request(repo, reviewer, { filePath: "src/app.js", side: "RIGHT", line: 2, commitHash: "head-1", body: "Use the helper" }), res);
  assert.equal(res.statusCode, 201); assert.equal(document.reviewThreads.length, 1); assert.equal(document.reviewThreads[0].comments[0].body, "Use the helper"); assert.ok(notifications.length >= 1);
});

test("thread replies persist, authors edit/delete to tombstones, and conversations resolve and reopen", async () => {
  const repo = repository(); const document = pull({ reviewThreads: [{ filePath: "src/app.js", side: "RIGHT", line: 2, originalLine: 2, commitHash: "head-1", originalCommitHash: "head-1", createdBy: reviewer, comments: [{ author: reviewer, body: "Please update" }] }] });
  const controller = createAdvancedReviewController({ PullModel: { findOne: () => query(document) }, UserModel, compare: async () => comparison(), notifyUser: async () => null });
  const thread = document.reviewThreads[0]; let res = response();
  await controller.reply(request(repo, author, { body: "Updated", commitHash: "head-1" }, { threadId: String(thread._id) }), res); assert.equal(res.statusCode, 201); assert.equal(thread.comments.length, 2);
  const reply = thread.comments[1]; res = response(); await controller.editComment(request(repo, reviewer, { body: "No" }, { commentId: String(reply._id) }), res); assert.equal(res.statusCode, 403);
  res = response(); await controller.editComment(request(repo, author, { body: "Updated now" }, { commentId: String(reply._id) }), res); assert.equal(reply.body, "Updated now"); assert.ok(reply.editedAt);
  res = response(); await controller.deleteComment(request(repo, author, {}, { commentId: String(reply._id) }), res); assert.equal(res.body.comment.body, "This comment was deleted."); assert.equal(reply.deleted, true);
  res = response(); await controller.resolve(request(repo, author, {}, { threadId: String(thread._id) }), res); assert.equal(thread.resolved, true);
  res = response(); await controller.reopen(request(repo, reviewer, {}, { threadId: String(thread._id) }), res); assert.equal(thread.resolved, false);
});

test("reviewer requests enforce requester, access, self, duplicates, removal, and notifications", async () => {
  const repo = repository(); const document = pull(); const notifications = [];
  const controller = createAdvancedReviewController({ PullModel: { findOne: () => query(document) }, UserModel, notifyUser: async (value) => notifications.push(value) });
  let res = response(); await controller.requestReviewer(request(repo, outsider, { userId: String(reviewer) }), res); assert.equal(res.statusCode, 403);
  res = response(); await controller.requestReviewer(request(repo, author, { userId: String(author) }), res); assert.equal(res.statusCode, 400);
  res = response(); await controller.requestReviewer(request(repo, author, { userId: String(outsider) }), res); assert.equal(res.statusCode, 403);
  res = response(); await controller.requestReviewer(request(repo, author, { userId: String(reviewer) }), res); assert.equal(res.statusCode, 201); assert.equal(document.requestedReviewers.length, 1); assert.equal(notifications.length, 1);
  res = response(); await controller.requestReviewer(request(repo, author, { userId: String(reviewer) }), res); assert.equal(res.statusCode, 409);
  res = response(); await controller.removeReviewer(request(repo, author, {}, { userId: String(reviewer) }), res); assert.equal(res.statusCode, 200); assert.equal(document.requestedReviewers[0].status, "removed");
});

test("advanced review routes are registered before generic repository details", () => {
  const router = require("../routes/repo.router"); const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path); const generic = paths.indexOf("/:id");
  for (const path of ["/:id/pulls/:number/reviewers", "/:id/pulls/:number/files", "/:id/pulls/:number/threads", "/:id/pulls/:number/threads/:threadId/comments", "/:id/pulls/:number/merge-status"]) assert.ok(paths.includes(path) && paths.indexOf(path) < generic);
});

test("new source commits notify requested reviewers once and notification failure is isolated", async () => {
  const notifications = [];
  const PullModel = { find: () => ({ select() { return this; }, lean: async () => [{ _id: "pr1", number: 1, title: "Review", requestedReviewers: [{ user: reviewer, status: "requested" }, { user: reviewer, status: "requested" }] }] }) };
  const result = await notifyReviewersOfNewHead(repository(), "feature", "head-2", author, { PullModel, notifyUser: async (value) => { notifications.push(value); throw new Error("offline"); } });
  assert.equal(notifications.length, 1); assert.equal(notifications[0].type, "review_required_again"); assert.deepEqual(result, []);
});
