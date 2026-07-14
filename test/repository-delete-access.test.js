const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const {
  requireRepositoryWrite,
} = require("../utils/repositoryAccess");
const { deleteRepositoryById } = require("../controllers/repoController");

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(value) { this.body = value; return this; },
});

test("repository delete access rejects authenticated non-owners and ownerless legacy repositories", async (t) => {
  const originalFindById = Repository.findById;
  const originalSecret = process.env.JWT_SECRET_KEY;
  process.env.JWT_SECRET_KEY = "repository-delete-test-secret";
  t.after(() => {
    Repository.findById = originalFindById;
    process.env.JWT_SECRET_KEY = originalSecret;
  });

  const authenticatedUserId = new mongoose.Types.ObjectId();
  const token = jwt.sign({ id: authenticatedUserId }, process.env.JWT_SECRET_KEY);
  const req = {
    params: { id: String(new mongoose.Types.ObjectId()) },
    headers: { authorization: `Bearer ${token}` },
  };

  for (const owner of [new mongoose.Types.ObjectId(), null]) {
    Repository.findById = async () => ({ owner, visibility: "public" });
    const res = response();
    let nextCalled = false;
    await requireRepositoryWrite(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
  }
});

test("repository delete access allows the owner and the controller deletes the authorized document", async (t) => {
  const originalFindById = Repository.findById;
  const originalSecret = process.env.JWT_SECRET_KEY;
  process.env.JWT_SECRET_KEY = "repository-delete-test-secret";
  t.after(() => {
    Repository.findById = originalFindById;
    process.env.JWT_SECRET_KEY = originalSecret;
  });

  const owner = new mongoose.Types.ObjectId();
  let deleteCalls = 0;
  const repository = {
    owner,
    visibility: "private",
    async deleteOne() { deleteCalls += 1; },
  };
  Repository.findById = async () => repository;
  const req = {
    params: { id: String(new mongoose.Types.ObjectId()) },
    headers: {
      authorization: `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET_KEY)}`,
    },
  };
  const accessResponse = response();
  let nextCalled = false;
  await requireRepositoryWrite(req, accessResponse, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.repository, repository);
  const deleteResponse = response();
  await deleteRepositoryById(req, deleteResponse);
  assert.equal(deleteResponse.statusCode, 200);
  assert.deepEqual(deleteResponse.body, { message: "Repository deleted!" });
  assert.equal(deleteCalls, 1);
});

test("repository delete route requires owner-level permission before the controller", () => {
  const router = require("../routes/repo.router");
  const route = router.stack.find((layer) => layer.route?.path === "/delete/:id");
  assert.ok(route);
  assert.equal(route.route.stack.length, 2);
  assert.notEqual(route.route.stack[0].handle, deleteRepositoryById);
  assert.equal(route.route.stack[1].handle, deleteRepositoryById);
});
