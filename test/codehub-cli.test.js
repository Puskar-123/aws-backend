const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCliAuthController } = require("../controllers/cliAuthController");
const { createRepositoryCliController } = require("../controllers/repositoryCliController");

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const ownerId = "507f1f77bcf86cd799439011";
const repoId = "507f1f77bcf86cd799439012";

test("CLI login accepts username or email and returns a purpose-scoped expiring token without password data", async () => {
  let query;
  const user = { _id: ownerId, username: "pdey26", name: "P Dey", password: "hash" };
  const UserModel = { findOne(value) { query = value; return { select: async () => user }; } };
  const controller = createCliAuthController({ UserModel, compare: async () => true, sign: (payload) => { assert.equal(payload.purpose, "cli"); return "safe-token"; } });
  const res = response();
  await controller.login({ ip: "login-success", body: { usernameOrEmail: "pdey26", password: "secret" } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.accessToken, "safe-token"); assert.equal(res.body.user.username, "pdey26");
  assert.equal(res.body.user.password, undefined); assert.deepEqual(query.$or, [{ username: "pdey26" }, { email: "pdey26" }]);
});

test("CLI login rejects invalid credentials with a stable code", async () => {
  const UserModel = { findOne() { return { select: async () => null }; } };
  const res = response(); await createCliAuthController({ UserModel }).login({ ip: "login-invalid", body: { usernameOrEmail: "nobody", password: "bad" } }, res);
  assert.equal(res.statusCode, 401); assert.equal(res.body.code, "INVALID_CREDENTIALS"); assert.equal(res.body.accessToken, undefined);
});

test("CLI metadata returns safe role, refs, permissions, and protection state", async () => {
  const repository = { _id: repoId, name: "project", visibility: "private", owner: { _id: ownerId, username: "Puskar" }, collaborators: [], defaultBranch: "main", branches: [{ name: "main", head: "abc", isDefault: true }], branchProtections: [] };
  const res = response(); await createRepositoryCliController().metadata({ params: { id: repoId }, user: { id: ownerId }, repository }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.repository.owner, "Puskar"); assert.equal(res.body.currentUserRole, "owner"); assert.equal(res.body.permissions.canPush, true); assert.equal(res.body.branches[0].head, "abc");
  assert.equal(JSON.stringify(res.body).includes("collaborators"), false);
});

test("read collaborators can clone and pull metadata but cannot push", async () => {
  const readId = "507f1f77bcf86cd799439099";
  const repository = { _id: repoId, name: "private-project", visibility: "private", owner: { _id: ownerId, username: "Puskar" }, collaborators: [{ user: readId, role: "read" }], defaultBranch: "main", branches: [{ name: "main", head: null, isDefault: true }], branchProtections: [] };
  const res = response(); await createRepositoryCliController().metadata({ params: { id: repoId }, user: { id: readId }, repository }, res);
  assert.equal(res.body.currentUserRole, "read"); assert.equal(res.body.permissions.canClone, true); assert.equal(res.body.permissions.canPull, true); assert.equal(res.body.permissions.canPush, false);
});

test("transactional CLI push verifies hashes, preserves the snapshot, advances the branch atomically, and notifies safely", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codehub-cli-push-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const contents = Buffer.from("hello from cli\n"); const hash = crypto.createHash("sha256").update(contents).digest("hex"); const uploadedPath = path.join(root, "upload"); await fs.writeFile(uploadedPath, contents);
  const commitHash = crypto.createHash("sha256").update("commit").digest("hex");
  const repository = { _id: repoId, name: "project", visibility: "private", owner: ownerId, collaborators: [], defaultBranch: "main", content: [{ filename: "old.txt", path: "old.txt", hash: "old", s3Key: "old-key" }], commits: [{ hash: "remote-head", snapshot: [{ filename: "old.txt", path: "old.txt", hash: "old", s3Key: "old-key" }] }], branches: [{ name: "main", head: "remote-head", isDefault: true }], branchProtections: [], watchers: [] };
  let update; let notified = 0;
  const RepositoryModel = { async findOneAndUpdate(filter, value) { assert.equal(filter.branches.$elemMatch.head, "remote-head"); update = value; return { ...repository, branches: [{ name: "main", head: commitHash }], commits: [...repository.commits, ...value.$push.commits.$each] }; } };
  const UserModel = { findById() { return { select() { return { lean: async () => ({ _id: ownerId, username: "Puskar" }) }; } }; } };
  const storage = { upload(input) { assert.equal(input.Key, `repos/${repoId}/commits/${commitHash}/src/app.txt`); return { promise: async () => ({}) }; } };
  const controller = createRepositoryCliController({ RepositoryModel, UserModel, storage, bucket: "bucket", notifyWatchers: async () => { notified += 1; }, notifyReviewers: async () => {} });
  const manifest = { branch: "main", expectedRemoteHead: "remote-head", commits: [{ localCommitId: commitHash, parent: "remote-head", message: "CLI commit", createdAt: "2026-07-14T00:00:00Z", changes: [{ path: "src/app.txt", type: "added", hash }] }] };
  const req = { params: { id: repoId }, user: { id: ownerId }, repository, body: { manifest: JSON.stringify(manifest) }, files: [{ path: uploadedPath, originalname: `blob-${hash}`, size: contents.length, mimetype: "text/plain" }] };
  const res = response(); await controller.push(req, res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.head, commitHash); assert.equal(res.body.commitsCreated, 1); assert.equal(notified, 1);
  const created = update.$push.commits.$each[0]; assert.equal(created.author.name, "Puskar"); assert.equal(created.snapshot.length, 2); assert.equal(created.files[0].path, "src/app.txt");
});

test("CLI push rejects stale heads and protected paths without creating commits", async () => {
  const commitHash = "a".repeat(64);
  const base = { _id: repoId, owner: ownerId, collaborators: [], defaultBranch: "main", content: [], commits: [], branches: [{ name: "main", head: "new-remote", isDefault: true }], branchProtections: [] };
  const UserModel = { findById() { return { select() { return { lean: async () => ({ _id: ownerId, username: "Puskar" }) }; } }; } };
  const controller = createRepositoryCliController({ UserModel, notifyWatchers: async () => {}, notifyReviewers: async () => {} });
  let res = response(); await controller.push({ params: { id: repoId }, user: { id: ownerId }, repository: base, body: { manifest: JSON.stringify({ branch: "main", expectedRemoteHead: "old", commits: [{ localCommitId: commitHash, parent: "old", message: "x", changes: [{ path: "app.js", type: "added", hash: "b".repeat(64) }] }] }) }, files: [] }, res);
  assert.equal(res.statusCode, 409); assert.equal(res.body.code, "REMOTE_CHANGED");
  const protectedRepo = { ...base, branches: [{ name: "main", head: null, isDefault: true }] };
  res = response(); await controller.push({ params: { id: repoId }, user: { id: ownerId }, repository: protectedRepo, body: { manifest: JSON.stringify({ branch: "main", expectedRemoteHead: null, commits: [{ localCommitId: commitHash, parent: null, message: "x", changes: [{ path: ".env", type: "deleted" }] }] }) }, files: [] }, res);
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, "PROTECTED_FILE");
});

test("CLI push obeys branch protection including owner bypass configuration", async () => {
  const repository = { _id: repoId, owner: ownerId, collaborators: [], defaultBranch: "main", content: [], commits: [], branches: [{ name: "main", head: null }], branchProtections: [{ branch: "main", enabled: true, requirePullRequest: true, allowOwnerBypass: false }] };
  const controller = createRepositoryCliController({ notifyWatchers: async () => {}, notifyReviewers: async () => {} }); const res = response();
  await controller.push({ params: { id: repoId }, user: { id: ownerId }, repository, body: { manifest: JSON.stringify({ branch: "main", expectedRemoteHead: null, commits: [{ localCommitId: "c".repeat(64), parent: null, message: "blocked", changes: [{ path: "a.txt", type: "deleted" }] }] }) }, files: [] }, res);
  assert.equal(res.statusCode, 403); assert.equal(res.body.code, "BRANCH_PROTECTED");
});

test("repeated CLI push finalization is idempotent and creates no duplicate commit", async () => {
  const finalHash = "d".repeat(64);
  const repository = { _id: repoId, owner: ownerId, collaborators: [], defaultBranch: "main", content: [], commits: [{ hash: finalHash }], branches: [{ name: "main", head: finalHash }], branchProtections: [] };
  let writes = 0; const RepositoryModel = { async findOneAndUpdate() { writes += 1; } };
  const res = response(); await createRepositoryCliController({ RepositoryModel }).push({ params: { id: repoId }, user: { id: ownerId }, repository, body: { manifest: JSON.stringify({ branch: "main", expectedRemoteHead: finalHash, commits: [{ localCommitId: finalHash, parent: null, message: "already", changes: [{ path: "a.txt", type: "deleted" }] }] }) }, files: [] }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.idempotent, true); assert.equal(res.body.commitsCreated, 0); assert.equal(writes, 0);
});

test("CLI auth and repository routes are registered before generic repository details", () => {
  const userRouter = require("../routes/user.router"); const repoRouter = require("../routes/repo.router");
  const userPaths = userRouter.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
  const repoPaths = repoRouter.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
  assert(userPaths.includes("post /cli/login")); assert(userPaths.includes("get /cli/session"));
  assert(repoPaths.includes("get /resolve/:owner/:name")); assert(repoPaths.includes("get /:id/cli/metadata")); assert(repoPaths.includes("post /:id/cli/push"));
  assert(repoPaths.indexOf("get /:id/cli/metadata") < repoPaths.indexOf("get /:id"));
});
