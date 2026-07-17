const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { REPOSITORY_PERMISSIONS: P, REPOSITORY_ROLES: R, ROLE_PERMISSION_MAP } = require("../constants/repositoryPermissions");
const RepositoryMember = require("../models/repositoryMemberModel");
const RepositoryRoleAudit = require("../models/repositoryRoleAuditModel");
const PullRequestTestResult = require("../models/pullRequestTestResultModel");
const { getRepositoryRole, hasRepositoryPermission, canViewRepository, resolveRepositoryPermissionContext,
  assertRepositoryPermission, canAccessBranch, normalizeAllowedBranches, getEffectiveMembershipStatus } = require("../services/repositoryPermissionService");
const { validateAccessConfiguration, assertActorCanAssign } = require("../services/repositoryMemberService");
const { runMigration } = require("../scripts/migrateRepositoryRoles");

const oid = () => new mongoose.Types.ObjectId();
const repository = (overrides = {}) => ({ _id: oid(), owner: oid(), visibility: "private", collaborators: [], branchProtections: [], ...overrides });
const member = (repo, user, role, overrides = {}) => ({ _id: oid(), repository: repo._id, user, role, status: "active", allowedBranches: [], ...overrides });

test("central constants expose every built-in role and unique permission strings", () => {
  assert.deepEqual(new Set(Object.values(R)), new Set(["owner", "maintainer", "viewer", "issue_manager", "tester", "reviewer", "temporary_contributor", "deployment_manager"]));
  assert.equal(new Set(Object.values(P)).size, Object.values(P).length);
});

test("owner fallback grants every repository permission without a membership record", async () => {
  const repo = repository();
  const context = await resolveRepositoryPermissionContext(repo, repo.owner, { MemberModel: { findOne() { throw new Error("owner must not query membership"); } } });
  assert.equal(context.role, R.OWNER); assert.deepEqual(new Set(context.permissions), new Set(Object.values(P)));
});

test("repository owner field is the only effective owner", () => {
  const repo = repository(); const other = oid();
  assert.equal(getRepositoryRole(repo, repo.owner, null), R.OWNER);
  assert.equal(getRepositoryRole(repo, other, member(repo, other, R.OWNER)), null);
});

test("viewer can read private repository but cannot write, commit, or push", () => {
  const repo = repository(); const user = oid(); const membership = member(repo, user, R.VIEWER); repo.$repositoryMembership = membership;
  assert.equal(canViewRepository(repo, user), true); assert.equal(hasRepositoryPermission(repo, user, P.FILE_UPDATE), false);
  assert.equal(hasRepositoryPermission(repo, user, P.COMMIT_CREATE), false); assert.equal(hasRepositoryPermission(repo, user, P.BRANCH_PUSH), false);
});

test("issue manager manages issues without source or merge permission", () => {
  const repo = repository(); const user = oid(); const membership = member(repo, user, R.ISSUE_MANAGER); repo.$repositoryMembership = membership;
  assert.equal(hasRepositoryPermission(repo, user, P.ISSUE_CREATE), true); assert.equal(hasRepositoryPermission(repo, user, P.ISSUE_ASSIGN), true);
  assert.equal(hasRepositoryPermission(repo, user, P.FILE_UPDATE), false); assert.equal(hasRepositoryPermission(repo, user, P.PULL_MERGE), false);
});

test("tester submits results but cannot approve or merge", () => {
  assert.ok(ROLE_PERMISSION_MAP.tester.includes(P.TEST_SUBMIT_RESULT)); assert.ok(!ROLE_PERMISSION_MAP.tester.includes(P.PULL_APPROVE)); assert.ok(!ROLE_PERMISSION_MAP.tester.includes(P.PULL_MERGE));
});

test("reviewer approves and requests changes but cannot merge or delete", () => {
  assert.ok(ROLE_PERMISSION_MAP.reviewer.includes(P.PULL_APPROVE)); assert.ok(ROLE_PERMISSION_MAP.reviewer.includes(P.PULL_REQUEST_CHANGES));
  assert.ok(!ROLE_PERMISSION_MAP.reviewer.includes(P.PULL_MERGE)); assert.ok(!ROLE_PERMISSION_MAP.reviewer.includes(P.REPOSITORY_DELETE));
});

test("deployment manager publishes releases and triggers deployments without source writes", () => {
  assert.ok(ROLE_PERMISSION_MAP.deployment_manager.includes(P.RELEASE_PUBLISH)); assert.ok(ROLE_PERMISSION_MAP.deployment_manager.includes(P.DEPLOYMENT_TRIGGER));
  assert.ok(!ROLE_PERMISSION_MAP.deployment_manager.includes(P.FILE_UPDATE)); assert.ok(!ROLE_PERMISSION_MAP.deployment_manager.includes(P.BRANCH_PUSH));
});

test("maintainer manages code and lower roles but cannot delete repositories or assign maintainer", () => {
  assert.ok(ROLE_PERMISSION_MAP.maintainer.includes(P.BRANCH_PUSH)); assert.ok(ROLE_PERMISSION_MAP.maintainer.includes(P.MEMBER_UPDATE_ROLE));
  assert.ok(!ROLE_PERMISSION_MAP.maintainer.includes(P.REPOSITORY_DELETE));
  assert.throws(() => assertActorCanAssign(R.MAINTAINER, R.MAINTAINER), (error) => error.code === "OWNER_REQUIRED");
  assert.doesNotThrow(() => assertActorCanAssign(R.MAINTAINER, R.VIEWER));
});

test("normal role operations cannot assign owner", () => assert.throws(() => assertActorCanAssign(R.OWNER, R.OWNER), (error) => error.code === "OWNER_REQUIRED"));

test("new temporary access requires future expiry and an allowed branch", () => {
  assert.throws(() => validateAccessConfiguration(R.TEMPORARY_CONTRIBUTOR, { allowedBranches: ["feature/a"] }), /future expiration/i);
  assert.throws(() => validateAccessConfiguration(R.TEMPORARY_CONTRIBUTOR, { accessExpiresAt: new Date(Date.now() + 60000), allowedBranches: [] }), /at least one/i);
  assert.throws(() => normalizeAllowedBranches(["*"]), /invalid branch/i);
});

test("temporary contributor is restricted to normalized exact branches", () => {
  const membership = { role: R.TEMPORARY_CONTRIBUTOR, allowedBranches: ["feature/payment-page"] };
  assert.equal(canAccessBranch(membership, "feature/payment-page"), true); assert.equal(canAccessBranch(membership, "main"), false);
  assert.throws(() => normalizeAllowedBranches([" feature/a"]), /whitespace/i); assert.throws(() => normalizeAllowedBranches(["feature/a", "feature/a"]), /duplicate/i);
});

test("not-started and expired temporary access are enforced using server time", async () => {
  const repo = repository(); const user = oid(); const future = member(repo, user, R.TEMPORARY_CONTRIBUTOR, { accessStartsAt: new Date(Date.now() + 60000), accessExpiresAt: new Date(Date.now() + 120000), allowedBranches: ["feature/a"] });
  await assert.rejects(() => assertRepositoryPermission(repo, user, P.BRANCH_PUSH, { membership: future, branch: "feature/a", MemberModel: {} }), (error) => error.code === "ACCESS_NOT_STARTED");
  const expired = { ...future, accessStartsAt: new Date(Date.now() - 120000), accessExpiresAt: new Date(Date.now() - 60000), _id: null };
  assert.equal(getEffectiveMembershipStatus(expired, repo), "expired");
  await assert.rejects(() => assertRepositoryPermission(repo, user, P.BRANCH_PUSH, { membership: expired, branch: "feature/a", MemberModel: {} }), (error) => error.code === "ACCESS_EXPIRED");
});

test("retainViewerAfterExpiry grants only viewer permissions", async () => {
  const repo = repository(); const user = oid(); const expired = member(repo, user, R.TEMPORARY_CONTRIBUTOR, { accessExpiresAt: new Date(Date.now() - 1), retainViewerAfterExpiry: true, _id: null });
  const context = await resolveRepositoryPermissionContext(repo, user, { membership: expired, MemberModel: {} });
  assert.equal(context.role, R.VIEWER); assert.ok(context.permissions.includes(P.FILE_VIEW)); assert.ok(!context.permissions.includes(P.BRANCH_PUSH));
});

test("public repositories remain readable to unrelated visitors", () => assert.equal(canViewRepository(repository({ visibility: "public" }), null), true));

test("legacy write fallback retains non-protected source permission until converted", () => {
  const user = oid(); const repo = repository({ collaborators: [{ user, role: "write" }] });
  assert.equal(getRepositoryRole(repo, user), R.TEMPORARY_CONTRIBUTOR); assert.equal(hasRepositoryPermission(repo, user, P.BRANCH_PUSH), true);
});

test("membership, audit, and manual test-result models expose required constraints", () => {
  assert.ok(RepositoryMember.schema.indexes().some(([keys, options]) => keys.repository === 1 && keys.user === 1 && options.unique));
  assert.ok(RepositoryRoleAudit.schema.indexes().some(([keys]) => keys.repository === 1 && keys.createdAt === -1));
  assert.deepEqual(PullRequestTestResult.schema.path("status").options.enum, ["passed", "failed"]);
});

test("migration dry run maps owner, maintainer, write, and read without writes", async () => {
  const repo = repository({ collaborators: [{ user: oid(), role: "maintainer" }, { user: oid(), role: "write" }, { user: oid(), role: "read" }] });
  const writes = [];
  const RepositoryModel = { find() { return { select() { return { async *cursor() { yield repo; } }; } }; }, updateOne(...args) { writes.push(args); } };
  const MemberModel = { async exists() { return false; }, create(value) { writes.push(value); } }; const AuditModel = { updateOne(...args) { writes.push(args); } };
  const summary = await runMigration({ dryRun: true, RepositoryModel, MemberModel, AuditModel });
  assert.equal(summary.repositoriesScanned, 1); assert.equal(summary.ownersNormalized, 1); assert.equal(summary.maintainersMigrated, 1);
  assert.equal(summary.writeCollaboratorsMigrated, 1); assert.equal(summary.readCollaboratorsMigrated, 1); assert.equal(writes.length, 0);
});

test("migration is idempotent when memberships already exist", async () => {
  const repo = repository({ collaborators: [{ user: oid(), role: "write" }] }); let writes = 0;
  const RepositoryModel = { find() { return { select() { return { async *cursor() { yield repo; } }; } }; }, async updateOne() { writes += 1; } };
  const MemberModel = { async findOne(query) { return { role: String(query.user) === String(repo.owner) ? "owner" : "temporary_contributor", status: "active", migrationSource: String(query.user) === String(repo.owner) ? "legacy_owner" : "legacy_write" }; }, async create() { writes += 1; } }; const AuditModel = { async updateOne() { writes += 1; } };
  const summary = await runMigration({ dryRun: false, RepositoryModel, MemberModel, AuditModel });
  assert.equal(summary.duplicatesSkipped, 2); assert.equal(writes, 1);
});
