const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Issue = require("../models/issueModel");
const { createIssueController, issueObject, normalizeLabels } = require("../controllers/issueController");
const { createSessionController } = require("../controllers/sessionController");
const { noStore } = require("../middleware/noStore");

const repositoryId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const authorId = new mongoose.Types.ObjectId();
const pullId = new mongoose.Types.ObjectId();
const identity = (id) => ({ _id: id, username: String(id) === String(ownerId) ? "owner" : "author", name: "CodeHub user", avatarUrl: "" });
const UserModel = { findById(id) { return { select() { return Promise.resolve([ownerId, authorId].some((value) => String(value) === String(id)) ? identity(id) : null); } }; } };
const response = () => ({ statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader(name, value) { this.headers[name] = value; } });
const query = (value) => ({ populate() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
const repository = { _id: repositoryId, owner: ownerId, visibility: "private" };

function issue(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(), repository: repositoryId, number: 1, title: "Issue title", body: "Body", author: authorId,
    status: "open", priority: "none", labels: [], assignees: [], linkedPullRequests: [], comments: [], closedBy: null, closedAt: null,
    async save() { this.saved = true; },
    async populate(path) {
      if (path === "author") this.author = identity(this.author);
      if (path === "comments.author") this.comments = this.comments.map((comment) => ({ ...comment, author: identity(comment.author) }));
      if (path === "assignees") this.assignees = this.assignees.map((value) => identity(value));
      if (path === "closedBy") this.closedBy = identity(this.closedBy);
      return this;
    },
    toObject() { return { ...this, save: undefined, populate: undefined, toObject: undefined }; },
    ...overrides,
  };
}

test("issue schema preserves legacy fields and repository-number uniqueness", () => {
  const legacy = new Issue({ repository: repositoryId, title: "Legacy", description: "Old body", owner: "legacy-user", state: "closed", closed: true });
  assert.equal(legacy.validateSync(), undefined);
  assert.equal(issueObject(legacy).body, "Old body");
  assert.equal(issueObject(legacy).status, "closed");
  assert.ok(Issue.schema.indexes().some(([fields, options]) => fields.repository === 1 && fields.number === 1 && options.unique));
  assert.equal(Issue.schema.path("comments.author").options.ref, "User");
});

test("issue labels are normalized and reject duplicates and invalid colors", () => {
  assert.deepEqual(normalizeLabels([{ name: " Bug ", color: "#D73A4A" }]), [{ name: "Bug", color: "d73a4a" }]);
  assert.throws(() => normalizeLabels([{ name: "bug" }, { name: "BUG" }]), /Duplicate labels/);
  assert.throws(() => normalizeLabels([{ name: "bug", color: "red" }]), /six-character hex/);
});

test("creating an issue validates input, uses the authenticated user, and increments atomically", async () => {
  let incrementArgs; const created = [];
  const controller = createIssueController({
    UserModel,
    RepoModel: { findByIdAndUpdate: async (...args) => { incrementArgs = args; return { issueCounter: 7 }; } },
    IssueModel: { create: async (value) => { const document = issue(value); created.push(document); return document; } },
  });
  let res = response();
  await controller.create({ repository, user: { id: String(authorId) }, body: { title: "   " } }, res);
  assert.equal(res.statusCode, 400);
  res = response();
  await controller.create({ repository, user: { id: String(authorId) }, body: { title: " Fix tree ", body: " Details ", priority: "high", labels: [{ name: "bug", color: "d73a4a" }] } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created[0].number, 7);
  assert.equal(String(created[0].author._id), String(authorId));
  assert.deepEqual(incrementArgs[1], { $inc: { issueCounter: 1 } });
});

test("comments, close/reopen, labels, assignees, and PR links enforce lifecycle rules", async () => {
  const document = issue();
  const IssueModel = { findOne: () => query(document) };
  const controller = createIssueController({ IssueModel, UserModel, PullModel: { findOne: async ({ repository: repo, number }) => String(repo) === String(repositoryId) && number === 3 ? { _id: pullId, number: 3 } : null } });
  let res = response();
  await controller.comment({ repository, user: { id: String(authorId) }, params: { number: "1" }, body: { body: " I can reproduce this. " } }, res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.comment.body, "I can reproduce this.");
  res = response(); await controller.close({ repository, user: { id: String(authorId) }, params: { number: "1" } }, res);
  assert.equal(document.status, "closed"); assert.equal(String(document.closedBy._id), String(authorId));
  res = response(); await controller.reopen({ repository, user: { id: String(ownerId) }, params: { number: "1" } }, res);
  assert.equal(document.status, "open"); assert.equal(document.closedBy, null);
  res = response(); await controller.addLabel({ repository, user: { id: String(ownerId) }, params: { number: "1" }, body: { name: "security", color: "a371f7" } }, res);
  assert.equal(res.body.labels[0].name, "security");
  res = response(); await controller.addAssignee({ repository, user: { id: String(ownerId) }, params: { number: "1" }, body: { userId: String(authorId) } }, res);
  assert.equal(res.body.assignees[0].username, "author");
  res = response(); await controller.linkPullRequest({ repository, user: { id: String(ownerId) }, params: { number: "1" }, body: { pullRequestNumber: 3 } }, res);
  assert.equal(String(res.body.linkedPullRequests[0]), String(pullId));
});

test("issue update is allowlisted and rejects unauthorized users", async () => {
  const document = issue(); const controller = createIssueController({ IssueModel: { findOne: () => query(document) } });
  let res = response();
  await controller.update({ repository, user: { id: String(new mongoose.Types.ObjectId()) }, params: { number: "1" }, body: { title: "Denied" } }, res);
  assert.equal(res.statusCode, 403);
  res = response(); await controller.update({ repository, user: { id: String(authorId) }, params: { number: "1" }, body: { title: " Updated ", status: "closed", repository: new mongoose.Types.ObjectId() } }, res);
  assert.equal(document.title, "Updated"); assert.equal(document.status, "open"); assert.equal(String(document.repository), String(repositoryId));
});

test("session validation handles valid and deleted users and protected responses are no-store", async () => {
  const controller = createSessionController({ UserModel });
  let res = response(); await controller.session({ user: { id: String(authorId) } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.user.username, "author"); assert.equal(res.body.user.password, undefined);
  res = response(); await controller.session({ user: { id: String(new mongoose.Types.ObjectId()) } }, res);
  assert.equal(res.statusCode, 401);
  res = response(); let nextCalled = false; noStore({}, res, () => { nextCalled = true; });
  assert.equal(res.headers["Cache-Control"], "no-store, private"); assert.equal(res.headers.Pragma, "no-cache"); assert.equal(res.headers.Expires, "0"); assert.equal(nextCalled, true);
});

test("issue routes are registered before generic repository details", () => {
  const router = require("../routes/repo.router");
  const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean); const generic = paths.indexOf("/:id");
  for (const path of ["/:id/issues", "/:id/issues/:number", "/:id/issues/:number/comments", "/:id/issues/:number/close", "/:id/issues/:number/labels", "/:id/issues/:number/assignees", "/:id/issues/:number/link-pr"]) {
    assert.ok(paths.includes(path)); assert.ok(paths.indexOf(path) < generic);
  }
});
