const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const controller = require("../controllers/branchProtectionController");
const {
  getBranchProtection, assertCanDirectWrite, assertCanDeleteBranch,
  evaluateMergeProtection, assertCanMergePullRequest, getProtectionSummary,
} = require("../services/branchProtectionService");

const oid = () => new mongoose.Types.ObjectId();
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const rule = (overrides = {}) => ({ branch: "main", enabled: true, requirePullRequest: true, requiredApprovals: 1, blockDirectCommits: true, blockForcePush: true, blockDeletion: true, requireResolvedConversations: false, dismissStaleApprovals: false, allowOwnerBypass: false, allowMaintainerBypass: false, ...overrides });
const repository = (overrides = {}) => {
  const owner = oid();
  return { _id: oid(), owner, defaultBranch: "main", branches: [{ name: "main", head: "m1", isDefault: true }, { name: "feature/test", head: "f1" }], collaborators: [], branchProtections: [rule()], ...overrides };
};

test("repository schema stores legacy-safe embedded branch protection rules", () => {
  assert.ok(Repository.schema.path("branchProtections"));
  assert.equal(Repository.schema.path("branchProtections.requiredApprovals").options.max, 10);
  const legacy = new Repository({ name: `legacy-${Date.now()}`, owner: oid() });
  assert.deepEqual(legacy.branchProtections, []);
});

test("unprotected branches retain existing direct-write behavior", () => {
  const repo = repository(); const writer = oid(); repo.collaborators.push({ user: writer, role: "write" });
  assert.deepEqual(assertCanDirectWrite(repo, "feature/test", writer), { protected: false, canBypass: false });
});

test("write and maintainer collaborators cannot bypass protected direct writes by default", () => {
  const repo = repository(); const writer = oid(); const maintainer = oid();
  repo.collaborators.push({ user: writer, role: "write" }, { user: maintainer, role: "maintainer" });
  for (const user of [writer, maintainer]) assert.throws(() => assertCanDirectWrite(repo, "main", user, "commit"), (error) => error.status === 403 && error.code === "BRANCH_PROTECTED" && error.branch === "main");
});

test("owner bypass is honored only when explicitly enabled", () => {
  const repo = repository();
  assert.throws(() => assertCanDirectWrite(repo, "main", repo.owner), { status: 403 });
  repo.branchProtections[0].allowOwnerBypass = true;
  assert.equal(assertCanDirectWrite(repo, "main", repo.owner).canBypass, true);
});

test("maintainer bypass can be explicitly enabled without granting settings permission", () => {
  const maintainer = oid(); const repo = repository({ collaborators: [{ user: maintainer, role: "maintainer" }] });
  repo.branchProtections[0].allowMaintainerBypass = true;
  assert.equal(assertCanDirectWrite(repo, "main", maintainer).canBypass, true);
});

test("require-pull-request blocks direct writes even when blockDirectCommits is false", () => {
  const repo = repository({ branchProtections: [rule({ blockDirectCommits: false, requirePullRequest: true })] });
  assert.throws(() => assertCanDirectWrite(repo, "main", oid()), (error) => error.code === "BRANCH_PROTECTED");
});

test("protected branch deletion has no bypass and default deletion remains separately enforceable", () => {
  const repo = repository({ branchProtections: [rule({ allowOwnerBypass: true })] });
  assert.throws(() => assertCanDeleteBranch(repo, "main", repo.owner), (error) => error.status === 403 && /cannot be deleted/.test(error.message));
  repo.branchProtections = [];
  assert.equal(assertCanDeleteBranch(repo, "main", repo.owner), true);
});

test("latest valid reviewer decisions count once and PR author approval never counts", () => {
  const reviewer = oid(); const author = oid();
  const repo = repository({ collaborators: [{ user: reviewer, role: "write" }, { user: author, role: "write" }] });
  const pull = { baseBranch: "main", author, reviews: [
    { reviewer, decision: "approved", commitHead: "f1" },
    { reviewer, decision: "approved", commitHead: "f1" },
    { reviewer: author, decision: "approved", commitHead: "f1" },
  ] };
  const summary = evaluateMergeProtection(repo, pull, "f1");
  assert.equal(summary.currentApprovals, 1);
  assert.equal(summary.requirementsPassed, true);
});

test("insufficient approvals produce a structured merge error", () => {
  const repo = repository({ branchProtections: [rule({ requiredApprovals: 2 })] });
  const pull = { baseBranch: "main", author: oid(), reviews: [] };
  assert.throws(() => assertCanMergePullRequest(repo, pull, "f1"), (error) => error.status === 409 && error.code === "APPROVAL_REQUIRED" && error.required === 2 && error.current === 0);
});

test("changes requested blocks merge and a later approval replaces it", () => {
  const reviewer = oid(); const repo = repository({ collaborators: [{ user: reviewer, role: "write" }] });
  const pull = { baseBranch: "main", author: oid(), reviews: [{ reviewer, decision: "changes_requested", commitHead: "f1" }] };
  assert.throws(() => assertCanMergePullRequest(repo, pull, "f1"), (error) => error.code === "CHANGES_REQUESTED");
  pull.reviews.push({ reviewer, decision: "approved", commitHead: "f1" });
  assert.equal(assertCanMergePullRequest(repo, pull, "f1").requirementsPassed, true);
});

test("stale approvals are ignored only when dismissStaleApprovals is enabled", () => {
  const reviewer = oid(); const repo = repository({ collaborators: [{ user: reviewer, role: "write" }], branchProtections: [rule({ dismissStaleApprovals: true })] });
  const pull = { baseBranch: "main", author: oid(), reviews: [{ reviewer, decision: "approved", commitHead: "old" }] };
  assert.equal(evaluateMergeProtection(repo, pull, "new").currentApprovals, 0);
  repo.branchProtections[0].dismissStaleApprovals = false;
  assert.equal(evaluateMergeProtection(repo, pull, "new").currentApprovals, 1);
});

test("safe protection summaries expose rules without actor IDs", () => {
  const repo = repository(); const summary = getProtectionSummary(repo, "main", repo.owner);
  assert.equal(summary.protected, true);
  assert.equal(summary.requiredApprovals, 1);
  assert.equal(summary.createdBy, undefined);
});

test("owner can create, update, and remove a protection rule", async () => {
  const repo = repository({ branchProtections: [] }); repo.save = async () => repo;
  let res = response(); await controller.create({ repository: repo, user: { id: repo.owner }, body: { branch: "main", requiredApprovals: 1 } }, res);
  assert.equal(res.statusCode, 201); assert.equal(repo.branchProtections.length, 1);
  res = response(); await controller.update({ repository: repo, user: { id: repo.owner }, params: { branch: "main" }, body: { requiredApprovals: 2, allowOwnerBypass: false } }, res);
  assert.equal(res.body.protection.rules.requiredApprovals, 2);
  res = response(); await controller.remove({ repository: repo, user: { id: repo.owner }, params: { branch: "main" } }, res);
  assert.equal(res.statusCode, 200); assert.equal(repo.branchProtections.length, 0);
});

test("settings validation rejects missing branches, invalid approvals, booleans, and duplicates", async () => {
  const repo = repository(); repo.save = async () => repo;
  let res = response(); await controller.create({ repository: repo, user: { id: repo.owner }, body: { branch: "missing" } }, res); assert.equal(res.statusCode, 404);
  res = response(); await controller.create({ repository: repo, user: { id: repo.owner }, body: { branch: "feature/test", requiredApprovals: 11 } }, res); assert.equal(res.statusCode, 400);
  res = response(); await controller.create({ repository: repo, user: { id: repo.owner }, body: { branch: "feature/test", requireResolvedConversations: true } }, res); assert.equal(res.statusCode, 400);
  res = response(); await controller.create({ repository: repo, user: { id: repo.owner }, body: { branch: "feature/test", blockDeletion: "yes" } }, res); assert.equal(res.statusCode, 400);
  res = response(); await controller.create({ repository: repo, user: { id: repo.owner }, body: { branch: "main" } }, res); assert.equal(res.statusCode, 409);
});

test("settings routes are owner-permission protected and precede repository details", () => {
  const router = require("../routes/repo.router");
  const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  for (const path of ["/:id/branch-protection", "/:id/branch-protection/:branch"]) assert.ok(paths.indexOf(path) > -1 && paths.indexOf(path) < paths.indexOf("/:id"));
});
