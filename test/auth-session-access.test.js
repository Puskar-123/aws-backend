const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const repoController = require("../controllers/repoController");
const { requireAuth } = require("../middleware/authMiddleware");
const { requireRepositoryRead } = require("../utils/repositoryAccess");

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("session authentication rejects missing, invalid, and expired JWTs", (t) => {
  const originalSecret = process.env.JWT_SECRET_KEY;
  process.env.JWT_SECRET_KEY = "session-route-test-secret";
  t.after(() => { process.env.JWT_SECRET_KEY = originalSecret; });
  const expired = jwt.sign({ id: String(new mongoose.Types.ObjectId()) }, process.env.JWT_SECRET_KEY, { expiresIn: -1 });
  for (const headers of [{}, { authorization: "Bearer invalid" }, { authorization: `Bearer ${expired}` }]) {
    const req = { headers }; const res = response(); let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401); assert.equal(nextCalled, false);
  }
  const id = String(new mongoose.Types.ObjectId());
  const req = { headers: { authorization: `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET_KEY)}` } }; const res = response(); let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true); assert.equal(req.user.id, id);
});

test("the session endpoint applies no-store before JWT and user validation", () => {
  const router = require("../routes/user.router");
  const route = router.stack.find((layer) => layer.route?.path === "/session");
  assert.deepEqual(route.route.stack.map((layer) => layer.handle.name), ["noStore", "requireAuth", "session"]);
});

test("private repository reads return 401 without a JWT and 403 for another user", async (t) => {
  const originalFindById = Repository.findById; const originalSecret = process.env.JWT_SECRET_KEY;
  process.env.JWT_SECRET_KEY = "private-read-test-secret";
  const owner = new mongoose.Types.ObjectId(); const repositoryId = new mongoose.Types.ObjectId();
  Repository.findById = async () => ({ _id: repositoryId, owner, visibility: "private" });
  t.after(() => { Repository.findById = originalFindById; process.env.JWT_SECRET_KEY = originalSecret; });
  for (const [headers, expected] of [
    [{}, 401],
    [{ authorization: `Bearer ${jwt.sign({ id: String(new mongoose.Types.ObjectId()) }, process.env.JWT_SECRET_KEY)}` }, 403],
  ]) {
    const req = { params: { id: String(repositoryId) }, headers }; const res = response(); let nextCalled = false;
    await requireRepositoryRead(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, expected); assert.equal(nextCalled, false);
  }
});

test("repository, PR, and issue detail routes retain backend read authorization", () => {
  const router = require("../routes/repo.router");
  const find = (path, method) => router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack.map((layer) => layer.handle);
  assert.equal(find("/:id", "get")[1], requireRepositoryRead);
  assert.equal(find("/:id/pulls/:number", "get")[1], requireRepositoryRead);
  assert.equal(find("/:id/issues/:number", "get")[1], requireRepositoryRead);
  assert.equal(find("/:id/issues/:number/comments", "post")[1], requireRepositoryRead);
  assert.equal(find("/user/:userID", "get")[0].name, "requireAuth");
  assert.equal(find("/all", "get")[0].name, "optionalAuth");
});

test("repository discovery excludes other users' private repositories", async (t) => {
  const originalFind = Repository.find; const filters = [];
  Repository.find = (filter) => {
    filters.push(filter);
    return { populate() { return this; }, then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); } };
  };
  t.after(() => { Repository.find = originalFind; });
  let res = response(); await repoController.getAllRepositories({ user: null }, res);
  assert.deepEqual(filters[0], { visibility: { $ne: "private" } });
  const userId = String(new mongoose.Types.ObjectId());
  res = response(); await repoController.getAllRepositories({ user: { id: userId } }, res);
  assert.deepEqual(filters[1], { $or: [
    { visibility: { $ne: "private" } },
    { owner: userId },
    { "collaborators.user": userId },
  ] });
});
