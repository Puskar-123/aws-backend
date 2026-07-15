const test = require("node:test");
const assert = require("node:assert/strict");
const { getBranchState } = require("../services/branchService");
const { createFileEditController, MAX_EDIT_BYTES } = require("../controllers/fileEditController");

const owner = "507f1f77bcf86cd799439011";
const writer = "507f1f77bcf86cd799439012";
const reader = "507f1f77bcf86cd799439013";
const makeRepository = () => ({
  _id: "507f1f77bcf86cd799439099", name: "empty-project", owner, visibility: "public", defaultBranch: "main",
  branches: [{ name: "main", head: null, isDefault: true }], commits: [], content: [], collaborators: [], branchProtections: [], watchers: [],
  async save() { this.saved = true; },
});
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = (repository, userId = owner, body = {}) => ({ params: { id: repository._id }, repository, user: userId ? { id: userId } : null, body, query: {} });
const dependencies = (repository) => ({
  RepoModel: { findById: async () => repository },
  UserModel: { findById: () => ({ select: async () => ({ username: "developer", email: "developer@example.com" }) }) },
  storage: { putObject: (input) => ({ promise: async () => { repository.upload = input; } }) },
  bucket: "bucket", notify: async () => [],
});

test("branch empty state uses both reachable files and commits and supports legacy repositories", () => {
  const empty = makeRepository();
  assert.deepEqual(getBranchState(empty, "main"), { isEmpty: true, fileCount: 0, commitCount: 0 });
  const withFile = makeRepository(); withFile.content = [{ filename: "README.md", path: "README.md" }];
  assert.deepEqual(getBranchState(withFile, "main"), { isEmpty: false, fileCount: 1, commitCount: 0 });
  const withCommit = makeRepository(); withCommit.commits = [{ _id: "legacy-1", message: "Legacy", files: [] }];
  assert.deepEqual(getBranchState(withCommit, "main"), { isEmpty: false, fileCount: 0, commitCount: 1 });
  const legacy = { ...makeRepository(), branches: undefined, commits: undefined, content: undefined };
  legacy.branches = [{ name: "main", head: null, isDefault: true }];
  assert.deepEqual(getBranchState(legacy, "main"), { isEmpty: true, fileCount: 0, commitCount: 0 });
});

test("owner starter README creates one canonical commit, snapshot file, and non-empty state", async () => {
  const repository = makeRepository(); const controller = createFileEditController(dependencies(repository)); const res = response();
  await controller.create(request(repository, owner, { starterType: "readme", content: "# empty-project\n", branch: "main", commitMessage: "Initial commit" }), res);
  assert.equal(res.statusCode, 201); assert.equal(repository.commits.length, 1); assert.equal(repository.branches[0].head, repository.commits[0].hash);
  assert.equal(repository.commits[0].files[0].status, "added"); assert.equal(repository.commits[0].snapshot[0].path, "README.md");
  assert.equal(repository.content[0].path, "README.md"); assert.deepEqual(res.body.state, { isEmpty: false, fileCount: 1, commitCount: 1 });
  assert.match(repository.upload.Key, /\/commits\/[^/]+\/README\.md$/);
});

test("write collaborator can create a starter on an unprotected branch while read and public users cannot", async () => {
  for (const [role, userId, expected] of [["write", writer, 201], ["read", reader, 403], [null, null, 403]]) {
    const repository = makeRepository(); if (role) repository.collaborators = [{ user: userId, role }];
    const controller = createFileEditController(dependencies(repository)); const res = response();
    await controller.create(request(repository, userId, { starterType: "readme", content: "# Project\n", branch: "main" }), res);
    assert.equal(res.statusCode, expected); assert.equal(repository.commits.length, expected === 201 ? 1 : 0);
  }
});

test("branch protection blocks starter files and honors configured owner bypass", async () => {
  const repository = makeRepository();
  repository.branchProtections = [{ branch: "main", enabled: true, requirePullRequest: true, blockDirectCommits: true, allowOwnerBypass: false }];
  const controller = createFileEditController(dependencies(repository)); let res = response();
  await controller.create(request(repository, owner, { starterType: "gitignore", content: "node_modules/\n", branch: "main" }), res);
  assert.equal(res.statusCode, 403); assert.equal(repository.commits.length, 0);
  repository.branchProtections[0].allowOwnerBypass = true; res = response();
  await controller.create(request(repository, owner, { starterType: "gitignore", content: "node_modules/\n", branch: "main" }), res);
  assert.equal(res.statusCode, 201); assert.equal(repository.commits.length, 1);
});

test("starter validation rejects duplicates, invalid types, path injection, and oversized content", async () => {
  for (const starterType of ["readme", "gitignore", "license"]) {
    const repository = makeRepository(); const filename = { readme: "README.md", gitignore: ".gitignore", license: "LICENSE" }[starterType];
    repository.content = [{ filename, path: filename }]; const controller = createFileEditController(dependencies(repository)); const res = response();
    await controller.create(request(repository, owner, { starterType, content: "content", branch: "main" }), res);
    assert.equal(res.statusCode, 409); assert.match(res.body.error, /already exists/);
  }
  for (const starterType of ["unknown", "../README.md"]) {
    const repository = makeRepository(); const res = response();
    await createFileEditController(dependencies(repository)).create(request(repository, owner, { starterType, content: "content", branch: "main" }), res);
    assert.equal(res.statusCode, 400); assert.equal(repository.upload, undefined);
  }
  const repository = makeRepository(); const res = response();
  await createFileEditController(dependencies(repository)).create(request(repository, owner, { starterType: "readme", content: "x".repeat(MAX_EDIT_BYTES + 1), branch: "main" }), res);
  assert.equal(res.statusCode, 413); assert.equal(repository.upload, undefined);
});

test("starter POST route reuses authenticated repository write middleware before the controller", () => {
  const route = require("../routes/repo.router").stack.find((layer) => layer.route?.path === "/:id/file-editor" && layer.route.methods.post);
  assert.ok(route); assert.ok(route.route.stack.length >= 2); assert.equal(route.route.stack.at(-1).name, "create");
});
