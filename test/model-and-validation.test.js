const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const { validateBranchName } = require("../utils/branches");
const { normalizeRepositoryPath } = require("../utils/paths");

test("repository schema remains compatible with legacy commits", () => {
  const repository = new Repository({
    name: "legacy-repository",
    owner: new mongoose.Types.ObjectId(),
    content: [{ filename: "README.md", path: "README.md" }],
    commits: [{ message: "Old commit", time: new Date() }],
  });
  assert.equal(repository.validateSync(), undefined);
});

test("repository schema accepts branch-aware commit metadata", () => {
  const hash = "a".repeat(64);
  const repository = new Repository({
    name: "branch-repository",
    owner: new mongoose.Types.ObjectId(),
    branches: [{ name: "main", head: hash, isDefault: true }],
    commits: [{
      hash,
      parent: null,
      parents: [],
      branch: "main",
      author: { name: "A User", email: "user@example.com" },
      message: "Initial commit",
      files: [{ filename: "app.js", path: "src/app.js", hash, status: "added" }],
      deletedFiles: [],
      time: new Date(),
    }],
  });
  assert.equal(repository.validateSync(), undefined);
});

test("branch and repository path validation rejects unsafe input", () => {
  assert.equal(validateBranchName("feature/login"), "feature/login");
  assert.throws(() => validateBranchName("../main"), /Invalid branch/);
  assert.equal(normalizeRepositoryPath("src/app.js"), "src/app.js");
  assert.throws(() => normalizeRepositoryPath("../secret"), /Unsafe/);
  assert.throws(() => normalizeRepositoryPath("C:\\secret"), /Unsafe/);
});
