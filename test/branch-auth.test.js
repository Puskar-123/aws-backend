const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const { createBranch } = require("../controllers/branchController");
const { requireRepositoryWrite } = require("../utils/repositoryAccess");

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(value) { this.body = value; return this; },
});

test("branch write access distinguishes missing, invalid, expired, forbidden, and owner tokens", async (t) => {
  const originalFindById = Repository.findById;
  const originalSecret = process.env.JWT_SECRET_KEY;
  process.env.JWT_SECRET_KEY = "branch-auth-test-secret";
  const owner = new mongoose.Types.ObjectId();
  Repository.findById = async () => ({ owner, visibility: "public" });
  t.after(() => {
    Repository.findById = originalFindById;
    process.env.JWT_SECRET_KEY = originalSecret;
  });

  const cases = [
    [{}, 401],
    [{ authorization: "Bearer invalid-token" }, 401],
    [{ authorization: `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET_KEY, { expiresIn: -1 })}` }, 401],
    [{ authorization: `Bearer ${jwt.sign({ id: new mongoose.Types.ObjectId() }, process.env.JWT_SECRET_KEY)}` }, 403],
  ];
  for (const [headers, expectedStatus] of cases) {
    const res = response();
    let nextCalled = false;
    await requireRepositoryWrite({ params: { id: String(new mongoose.Types.ObjectId()) }, headers }, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(nextCalled, false);
  }

  const req = {
    params: { id: String(new mongoose.Types.ObjectId()) },
    headers: { authorization: `Bearer ${jwt.sign({ id: owner }, process.env.JWT_SECRET_KEY)}` },
  };
  const res = response();
  let nextCalled = false;
  await requireRepositoryWrite(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(String(req.repository.owner), String(owner));
});

test("branch creation route applies repository write access before the controller", () => {
  const router = require("../routes/repo.router");
  const route = router.stack.find((layer) => layer.route?.path === "/:id/branches" && layer.route.methods.post);
  assert.ok(route);
  assert.equal(route.route.stack.length, 2);
  assert.equal(route.route.stack[0].handle, requireRepositoryWrite);
  assert.equal(route.route.stack[1].handle, createBranch);
});
