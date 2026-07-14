const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const Invitation = require("../models/repositoryInvitationModel");
const Notification = require("../models/notificationModel");
const {
  getRepositoryRole, hasRepositoryPermission, canViewRepository, permissionSummary,
} = require("../services/repositoryPermissionService");
const { getAccessibleRepository } = require("../utils/repositoryAccess");
const { safeInvitation, validateRole } = require("../controllers/repositoryCollaboratorController");

const oid = () => new mongoose.Types.ObjectId();

test("repository and invitation schemas store collaborators separately from the derived owner role", () => {
  assert.ok(Repository.schema.path("collaborators"));
  assert.equal(Repository.schema.path("collaborators.role").options.enum.includes("owner"), false);
  assert.deepEqual(Invitation.schema.path("role").options.enum, ["maintainer", "write", "read"]);
  const indexes = Invitation.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.repository === 1 && keys.invitedUser === 1 && options.unique));
  assert.ok(indexes.some(([keys]) => keys.invitedUser === 1 && keys.status === 1 && keys.createdAt === -1));
});

test("owner receives full permissions without being an embedded collaborator", () => {
  const owner = oid();
  const repository = { owner, visibility: "private", collaborators: [] };
  assert.equal(getRepositoryRole(repository, owner), "owner");
  for (const action of ["view", "write_files", "merge_pr", "manage_collaborators", "delete_repository", "change_visibility"]) {
    assert.equal(hasRepositoryPermission(repository, owner, action), true, action);
  }
});

test("maintainer can manage content and merge but cannot manage owner settings", () => {
  const user = oid();
  const repository = { owner: oid(), collaborators: [{ user, role: "maintainer" }] };
  assert.equal(hasRepositoryPermission(repository, user, "write_files"), true);
  assert.equal(hasRepositoryPermission(repository, user, "merge_pr"), true);
  assert.equal(hasRepositoryPermission(repository, user, "manage_issues"), true);
  assert.equal(hasRepositoryPermission(repository, user, "manage_collaborators"), false);
  assert.equal(hasRepositoryPermission(repository, user, "delete_repository"), false);
});

test("write can change content but cannot merge or manage settings", () => {
  const user = oid();
  const repository = { owner: oid(), collaborators: [{ user, role: "write" }] };
  assert.equal(hasRepositoryPermission(repository, user, "create_branch"), true);
  assert.equal(hasRepositoryPermission(repository, user, "write_files"), true);
  assert.equal(hasRepositoryPermission(repository, user, "review_pr"), true);
  assert.equal(hasRepositoryPermission(repository, user, "merge_pr"), false);
  assert.equal(hasRepositoryPermission(repository, user, "manage_settings"), false);
});

test("read can view a private repository but cannot use write APIs", () => {
  const user = oid();
  const repository = { owner: oid(), visibility: "private", collaborators: [{ user, role: "read" }] };
  assert.equal(canViewRepository(repository, user), true);
  assert.equal(hasRepositoryPermission(repository, user, "download"), true);
  assert.equal(hasRepositoryPermission(repository, user, "write_files"), false);
  assert.equal(hasRepositoryPermission(repository, user, "create_branch"), false);
});

test("pending, declined, and unrelated users receive no private access", () => {
  const repository = { owner: oid(), visibility: "private", collaborators: [] };
  assert.equal(canViewRepository(repository, oid()), false);
  assert.equal(canViewRepository(repository, null), false);
  assert.equal(permissionSummary(repository, oid()).permissions.canView, false);
});

test("role changes and removals take effect on the next permission evaluation", () => {
  const user = oid();
  const repository = { owner: oid(), visibility: "private", collaborators: [{ user, role: "read" }] };
  assert.equal(hasRepositoryPermission(repository, user, "write_files"), false);
  repository.collaborators[0].role = "write";
  assert.equal(hasRepositoryPermission(repository, user, "write_files"), true);
  repository.collaborators = [];
  assert.equal(canViewRepository(repository, user), false);
});

test("repository access rejects a read collaborator write with 403 and permits a write collaborator", async (t) => {
  const original = Repository.findById;
  const owner = oid(); const user = oid(); const repositoryId = oid();
  const repository = { _id: repositoryId, owner, visibility: "private", collaborators: [{ user, role: "read" }] };
  Repository.findById = () => ({ then(resolve, reject) { return Promise.resolve(repository).then(resolve, reject); } });
  t.after(() => { Repository.findById = original; });
  process.env.JWT_SECRET_KEY = "collaborator-test-secret";
  const req = { headers: { authorization: `Bearer ${jwt.sign({ id: String(user) }, process.env.JWT_SECRET_KEY)}` } };
  await assert.rejects(() => getAccessibleRepository(req, repositoryId, { write: true }), (error) => error.status === 403);
  repository.collaborators[0].role = "write";
  assert.equal(await getAccessibleRepository(req, repositoryId, { write: true }), repository);
});

test("legacy repositories without collaborators retain owner behavior", () => {
  const owner = oid();
  const repository = { owner, visibility: "private" };
  assert.equal(getRepositoryRole(repository, owner), "owner");
  assert.equal(canViewRepository(repository, oid()), false);
});

test("roles are allowlisted and owner cannot be assigned through invitations", () => {
  assert.equal(validateRole("WRITE"), "write");
  assert.throws(() => validateRole("owner"), /maintainer, write, or read/);
  assert.throws(() => validateRole("admin"), /maintainer, write, or read/);
});

test("invitation responses expose safe user and repository projections", () => {
  const output = safeInvitation({ _id: oid(), role: "write", status: "pending", repository: { _id: oid(), name: "private-project", visibility: "private", owner: { _id: oid(), username: "owner", email: "secret@example.com" } }, invitedUser: { _id: oid(), username: "guest", email: "hidden@example.com", password: "hidden" }, invitedBy: { _id: oid(), username: "owner", token: "hidden" }, expiresAt: new Date(), createdAt: new Date() });
  assert.equal(output.invitedUser.username, "guest");
  assert.equal(output.invitedUser.email, undefined);
  assert.equal(output.invitedUser.password, undefined);
  assert.equal(output.repository.owner.email, undefined);
  assert.equal(output.invitedBy.token, undefined);
});

test("collaborator notification types are registered", () => {
  const allowed = Notification.schema.path("type").options.enum;
  for (const type of ["repository_invitation", "repository_invitation_accepted", "repository_invitation_declined", "collaborator_removed", "collaborator_role_changed"]) assert.ok(allowed.includes(type));
});

test("collaborator and invitation routes are registered before repository details", () => {
  const repoRouter = require("../routes/repo.router");
  const mainRouter = require("../routes/main.router");
  const paths = repoRouter.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  for (const path of ["/:id/collaborators/invitations", "/:id/collaborators", "/:id/collaborators/:userId", "/:id/collaborators/invitations/:invitationId"]) assert.ok(paths.indexOf(path) > -1 && paths.indexOf(path) < paths.indexOf("/:id"));
  assert.ok(mainRouter.stack.some((layer) => layer.regexp?.toString().includes("invitations")));
});
