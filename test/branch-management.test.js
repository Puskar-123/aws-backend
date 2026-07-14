const assert = require("node:assert/strict");
const test = require("node:test");
const { createBranchController } = require("../controllers/branchController");
const { getBranchHistory, getBranchSnapshot } = require("../services/branchService");
const { ensureDefaultBranch } = require("../utils/branches");

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function repository(overrides = {}) {
  return {
    _id: "507f1f77bcf86cd799439011",
    name: "project",
    owner: "507f1f77bcf86cd799439012",
    visibility: "public",
    defaultBranch: "main",
    branches: [{ name: "main", head: "c2", isDefault: true }],
    content: [{ filename: "README.md", path: "README.md", s3Key: "repo/README.md" }],
    commits: [
      {
        hash: "c1",
        parent: null,
        branch: "main",
        message: "Initial",
        files: [{ filename: "README.md", path: "README.md", s3Key: "commits/c1/README.md", status: "added" }],
      },
      {
        hash: "c2",
        parent: "c1",
        branch: "main",
        message: "Add app",
        files: [{ filename: "app.js", path: "src/app.js", s3Key: "commits/c2/src/app.js", status: "added" }],
      },
    ],
    async save() { this.saved = true; },
    ...overrides,
  };
}

test("legacy repositories lazily expose main without migration", () => {
  const repo = repository({ branches: undefined, defaultBranch: undefined, commits: [] });
  const branch = ensureDefaultBranch(repo);
  assert.equal(branch.name, "main");
  assert.equal(branch.isDefault, true);
  assert.equal(repo.defaultBranch, "main");
});

test("branch listing includes default metadata and reachable commit counts", async () => {
  const repo = repository();
  const controller = createBranchController({ getRepository: async () => repo });
  const res = response();
  await controller.listBranches({ params: { id: repo._id } }, res);
  assert.equal(res.body.defaultBranch, "main");
  assert.equal(res.body.branches[0].commitCount, 2);
  assert.equal(res.body.branches[0].isDefault, true);
});

test("creating a branch copies the source head without duplicating files", async () => {
  const repo = repository();
  const controller = createBranchController({ getRepository: async () => repo });
  const res = response();
  await controller.createBranch({ params: { id: repo._id }, body: { name: "feature/login", sourceBranch: "main" } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.branch.head, "c2");
  assert.equal(repo.branches.at(-1).name, "feature/login");
  assert.equal(repo.content.length, 1);
  assert.equal(repo.saved, true);
});

test("duplicate and invalid branch names are rejected", async () => {
  const repo = repository();
  const controller = createBranchController({ getRepository: async () => repo });
  const duplicate = response();
  await controller.createBranch({ params: { id: repo._id }, body: { name: "main" } }, duplicate);
  assert.equal(duplicate.statusCode, 409);
  const invalid = response();
  await controller.createBranch({ params: { id: repo._id }, body: { name: "bad branch" } }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test("deleting a non-default branch removes only its reference", async () => {
  const repo = repository({ branches: [
    { name: "main", head: "c2", isDefault: true },
    { name: "feature/login", head: "c2", isDefault: false },
  ] });
  const controller = createBranchController({ getRepository: async () => repo });
  const res = response();
  await controller.deleteBranch({ params: { id: repo._id, branchName: "feature/login" }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(repo.branches.map((branch) => branch.name), ["main"]);
  assert.equal(repo.commits.length, 2);
});

test("default and currently selected branches cannot be deleted", async () => {
  const repo = repository({ branches: [
    { name: "main", head: "c2", isDefault: true },
    { name: "feature/login", head: "c2", isDefault: false },
  ] });
  const controller = createBranchController({ getRepository: async () => repo });
  const defaultResponse = response();
  await controller.deleteBranch({ params: { id: repo._id, branchName: "main" }, query: {} }, defaultResponse);
  assert.equal(defaultResponse.statusCode, 403);
  const selectedResponse = response();
  await controller.deleteBranch({ params: { id: repo._id, branchName: "feature/login" }, query: { selectedBranch: "feature/login" } }, selectedResponse);
  assert.equal(selectedResponse.statusCode, 400);
});

test("write authorization failures are preserved for create and delete", async () => {
  const forbidden = Object.assign(new Error("You do not have access to this repository"), { status: 403 });
  const controller = createBranchController({ getRepository: async () => { throw forbidden; } });
  const createResponse = response();
  await controller.createBranch({ params: { id: "id" }, body: { name: "feature/x" } }, createResponse);
  assert.equal(createResponse.statusCode, 403);
  const deleteResponse = response();
  await controller.deleteBranch({ params: { id: "id", branchName: "feature/x" }, query: {} }, deleteResponse);
  assert.equal(deleteResponse.statusCode, 403);
});

test("branch snapshot reconstructs incremental files without deleted entries", () => {
  const repo = repository({ commits: [
    {
      hash: "c1",
      snapshot: [
        { filename: "README.md", path: "README.md", s3Key: "c1/README.md" },
        { filename: "old.js", path: "old.js", s3Key: "c1/old.js" },
      ],
    },
    {
      hash: "c2",
      parent: "c1",
      files: [
        { filename: "app.js", path: "src/app.js", s3Key: "c2/src/app.js", status: "added" },
        { filename: "old.js", path: "old.js", status: "deleted" },
      ],
    },
  ] });
  const snapshot = getBranchSnapshot(repo, "main");
  assert.deepEqual(snapshot.files.map((file) => file.path).sort(), ["README.md", "src/app.js"]);
});

test("branch history follows ancestry and excludes unrelated commits", () => {
  const repo = repository({
    branches: [
      { name: "main", head: "c2", isDefault: true },
      { name: "feature", head: "f1", isDefault: false },
    ],
    commits: [
      { hash: "c1", parent: null, branch: "main", message: "Initial" },
      { hash: "c2", parent: "c1", branch: "main", message: "Main work" },
      { hash: "f1", parent: "c1", branch: "feature", message: "Feature work" },
      { hash: "other", parent: null, branch: "other", message: "Unrelated" },
    ],
  });
  assert.deepEqual(getBranchHistory(repo, "feature", "main").map((commit) => commit.hash), ["f1", "c1"]);
});

test("branch-specific routes are registered before the generic repository route", () => {
  const router = require("../routes/repo.router");
  const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean);
  const genericIndex = paths.indexOf("/:id");
  for (const route of [
    "/:id/branches",
    "/:id/branches/:branchName/snapshot",
    "/:id/branches/:branchName/history",
  ]) {
    assert.ok(paths.indexOf(route) >= 0);
    assert.ok(paths.indexOf(route) < genericIndex);
  }
});
