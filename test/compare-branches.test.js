const assert = require("node:assert/strict");
const test = require("node:test");
const { createCompareController } = require("../controllers/compareController");
const { compareRepository } = require("../services/compareService");

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function file(path, hash, key = path) {
  return { filename: path.split("/").at(-1), path, hash, s3Key: key };
}

function comparisonRepository() {
  const common = [
    file("README.md", "readme", "common-readme"),
    file("src/shared.js", "common", "common-shared"),
    file("src/delete-modify.js", "dm-common", "dm-common"),
    file("config/.env", "secret-old", "secret-old"),
  ];
  const main = [
    file("README.md", "readme", "common-readme"),
    file("src/shared.js", "base", "base-shared"),
    file("src/old-name.js", "rename", "rename-content"),
    file("src/deleted.js", "deleted", "deleted-content"),
    file("image.png", "binary-old", "binary-old"),
    file("config/.env", "secret-base", "secret-base"),
  ];
  const feature = [
    file("README.md", "readme", "common-readme"),
    file("src/shared.js", "compare", "compare-shared"),
    file("src/delete-modify.js", "dm-compare", "dm-compare"),
    file("src/new-name.js", "rename", "rename-content"),
    file("src/added.js", "added", "added-content"),
    file("image.png", "binary-new", "binary-new"),
    file("large.txt", "large", "large-content"),
    file("config/.env", "secret-compare", "secret-compare"),
  ];
  return {
    _id: "507f1f77bcf86cd799439011",
    name: "project",
    owner: { username: "developer", email: "developer@example.com" },
    defaultBranch: "main",
    branches: [
      { name: "main", head: "m1", isDefault: true },
      { name: "feature", head: "f1", isDefault: false },
      { name: "common", head: "c1", isDefault: false },
      { name: "same", head: "m1", isDefault: false },
    ],
    content: main,
    commits: [
      { hash: "c1", parent: null, branch: "main", message: "Common", time: new Date("2026-01-01"), snapshot: common },
      { hash: "m1", parent: "c1", branch: "main", message: "Main work", time: new Date("2026-01-02"), snapshot: main },
      { hash: "f1", parent: "c1", branch: "feature", message: "Feature work", time: new Date("2026-01-03"), snapshot: feature },
    ],
  };
}

const bodies = {
  "common-readme": "# Project\n",
  "common-shared": "const value = 'common';\n",
  "base-shared": "const value = 'base';\n",
  "compare-shared": "const value = 'compare';\n",
  "dm-common": "common\n",
  "dm-compare": "feature\n",
  "rename-content": "renamed\n",
  "deleted-content": "deleted\n",
  "added-content": "added\n",
  "binary-old": Buffer.from([0, 1, 2]),
  "binary-new": Buffer.from([0, 2, 3]),
  "large-content": "x".repeat(200),
};

const readObject = async (storedFile) => ({
  available: true,
  body: Buffer.isBuffer(bodies[storedFile.s3Key]) ? bodies[storedFile.s3Key] : Buffer.from(bodies[storedFile.s3Key] || ""),
  contentType: storedFile.path.endsWith(".png") ? "image/png" : "text/plain",
});

test("compare controller rejects missing, invalid, and identical branch parameters", async () => {
  const controller = createCompareController({ getRepository: async () => comparisonRepository() });
  const missingBase = response();
  await controller.compareBranches({ params: { id: "id" }, query: { compare: "feature" } }, missingBase);
  assert.equal(missingBase.statusCode, 400);
  const missingCompare = response();
  await controller.compareBranches({ params: { id: "id" }, query: { base: "main" } }, missingCompare);
  assert.equal(missingCompare.statusCode, 400);
  const invalid = response();
  await controller.compareBranches({ params: { id: "id" }, query: { base: "bad branch", compare: "feature" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const same = response();
  await controller.compareBranches({ params: { id: "id" }, query: { base: "main", compare: "main" } }, same);
  assert.equal(same.statusCode, 400);
});

test("compare controller preserves invalid ID, missing repository, and private authorization errors", async () => {
  for (const [status, message] of [[400, "Invalid repository ID"], [404, "Repository not found"], [403, "You do not have access"]]) {
    const error = Object.assign(new Error(message), { status });
    const controller = createCompareController({ getRepository: async () => { throw error; } });
    const res = response();
    await controller.compareBranches({ params: { id: "id" }, query: { base: "main", compare: "feature" } }, res);
    assert.equal(res.statusCode, status);
  }
});

test("missing base and compare branches return 404", async () => {
  const repo = comparisonRepository();
  await assert.rejects(() => compareRepository(repo, "missing", "feature", { readObject }), /Base branch/);
  await assert.rejects(() => compareRepository(repo, "main", "missing", { readObject }), /Compare branch/);
});

test("diverged comparison reports merge base, ahead, behind, and only compare commits", async () => {
  const result = await compareRepository(comparisonRepository(), "main", "feature", { readObject, maxBytes: 40 });
  assert.equal(result.ancestryAvailable, true);
  assert.equal(result.mergeBase, "c1");
  assert.equal(result.ahead, 1);
  assert.equal(result.behind, 1);
  assert.deepEqual(result.commits.map((commit) => commit.hash), ["f1"]);
});

test("ahead, behind, and identical-head comparisons are calculated without double counting", async () => {
  const repo = comparisonRepository();
  const ahead = await compareRepository(repo, "common", "feature", { readObject });
  assert.deepEqual([ahead.ahead, ahead.behind], [1, 0]);
  const behind = await compareRepository(repo, "main", "common", { readObject });
  assert.deepEqual([behind.ahead, behind.behind], [0, 1]);
  const identical = await compareRepository(repo, "main", "same", { readObject });
  assert.deepEqual([identical.ahead, identical.behind, identical.summary.filesChanged], [0, 0, 0]);
});

test("snapshot comparison detects added, modified, deleted, and unambiguous renamed files", async () => {
  const result = await compareRepository(comparisonRepository(), "main", "feature", { readObject });
  assert.ok(result.files.some((entry) => entry.path === "src/added.js" && entry.status === "added"));
  assert.ok(result.files.some((entry) => entry.path === "src/shared.js" && entry.status === "modified"));
  assert.ok(result.files.some((entry) => entry.path === "src/deleted.js" && entry.status === "deleted"));
  assert.ok(result.files.some((entry) => entry.path === "src/new-name.js" && entry.status === "renamed" && entry.oldPath === "src/old-name.js"));
  assert.equal(result.summary.renamed, 1);
});

test("text patches, binary files, and large files remain isolated", async () => {
  const result = await compareRepository(comparisonRepository(), "main", "feature", { readObject, maxBytes: 40 });
  const text = result.files.find((entry) => entry.path === "src/shared.js");
  assert.match(text.patch, /base/);
  assert.ok(text.additions > 0 && text.deletions > 0);
  const binary = result.files.find((entry) => entry.path === "image.png");
  assert.equal(binary.isBinary, true);
  assert.equal(binary.patch, null);
  const large = result.files.find((entry) => entry.path === "large.txt");
  assert.equal(large.tooLarge, true);
  assert.equal(large.patch, null);
});

test("three-way comparison flags both-modified and delete-modify conflicts", async () => {
  const result = await compareRepository(comparisonRepository(), "main", "feature", { readObject });
  assert.equal(result.files.find((entry) => entry.path === "src/shared.js").conflictReason, "both_modified");
  assert.equal(result.files.find((entry) => entry.path === "src/delete-modify.js").conflictReason, "delete_modify");
  assert.equal(result.summary.hasConflicts, true);
  assert.equal(result.summary.conflictCount, 3);
});

test("legacy history compares snapshots without fabricating ancestry", async () => {
  const repo = comparisonRepository();
  repo.branches = [{ name: "main", head: null, isDefault: true }, { name: "legacy", head: null, isDefault: false }];
  repo.commits = [];
  const result = await compareRepository(repo, "main", "legacy", { readObject });
  assert.equal(result.ancestryAvailable, false);
  assert.equal(result.mergeBase, null);
  assert.equal(result.ahead, null);
  assert.equal(result.behind, null);
  assert.match(result.warnings.join(" "), /ancestry unavailable/i);
});

test("protected files are excluded without attempting storage reads", async () => {
  let protectedReads = 0;
  const result = await compareRepository(comparisonRepository(), "main", "feature", {
    readObject: async (storedFile) => {
      if (storedFile.path.includes(".env")) protectedReads += 1;
      return readObject(storedFile);
    },
  });
  assert.equal(result.files.some((entry) => entry.path.includes(".env")), false);
  assert.equal(protectedReads, 0);
});

test("compare route is registered before the generic repository route", () => {
  const router = require("../routes/repo.router");
  const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean);
  assert.ok(paths.indexOf("/:id/compare") < paths.indexOf("/:id"));
});
