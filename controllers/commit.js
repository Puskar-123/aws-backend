const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const User = require("../models/userModel");
const { validateBranchName } = require("../utils/branches");
const { normalizeRepositoryPath } = require("../utils/paths");
const { assertCanDirectWrite } = require("../services/branchProtectionService");
const { commitsPath: workflowCommitsPath, listFiles, pendingFor, stagingPath: workflowStagingPath } = require("../utils/browserWorkflow");

async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const item of await fs.readdir(src)) {
      await copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    await fs.copyFile(src, dest);
  }
}

function safeString(value, fallback = "", maximum = 500) {
  return String(value || fallback).slice(0, maximum);
}

async function commitRepo(repoId, message, metadata = {}) {
  if (!mongoose.Types.ObjectId.isValid(repoId)) throw new Error("Invalid repository ID");
  const repo = await Repository.findById(repoId);
  if (!repo) throw new Error("Repository not found");

  const branch = validateBranchName(metadata.branch || "main");
  assertCanDirectWrite(repo, branch, metadata.authenticatedUserId, "commit");
  const authenticatedUser = await User.findById(metadata.authenticatedUserId)
    .select("_id username name email");
  if (!authenticatedUser) {
    const error = new Error("Authenticated user no longer exists");
    error.status = 401;
    throw error;
  }
  if (!repo.branches?.length) {
    repo.branches = [{ name: "main", head: null, isDefault: true }];
  }
  const existingBranch = repo.branches.find((item) => item.name === branch);
  const stagedPath = workflowStagingPath(repoId, authenticatedUser._id, branch);
  const commitsPath = workflowCommitsPath(repoId);
  const stagedFiles = await listFiles(stagedPath);
  if (!stagedFiles.length) {
    const error = new Error("No staged changes to commit");
    error.status = 400;
    throw error;
  }
  const storageId = uuidv4();
  const commitDir = path.join(commitsPath, storageId);
  await fs.mkdir(commitDir, { recursive: true });
  const userPending = pendingFor(repo, authenticatedUser._id, branch);
  const pendingParent = userPending.at(-1) || null;
  const parentCommit = pendingParent || (existingBranch?.head
    ? repo.commits.find((commit) => commit.hash === existingBranch.head || String(commit._id) === String(existingBranch.head))
    : null);
  if (parentCommit?.storageId) {
    try {
      await copyRecursive(path.join(commitsPath, parentCommit.storageId), commitDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await copyRecursive(stagedPath, commitDir);

  const hash = /^[a-f0-9]{64}$/.test(metadata.hash || "") ? metadata.hash : storageId;
  const inferredParent = parentCommit?.hash || (existingBranch?.head ? safeString(existingBranch.head, "", 128) : "");
  const parents = Array.isArray(metadata.parents)
    ? metadata.parents.map((parent) => safeString(parent, "", 128)).filter(Boolean).slice(0, 2)
    : (metadata.parent
      ? [safeString(metadata.parent, "", 128)]
      : (inferredParent ? [inferredParent] : []));
  const time = metadata.time && !Number.isNaN(Date.parse(metadata.time))
    ? new Date(metadata.time)
    : new Date();
  const author = {
    user: authenticatedUser._id,
    username: safeString(authenticatedUser.username, "", 100),
    displayName: safeString(authenticatedUser.name, "", 100),
    name: safeString(authenticatedUser.name || authenticatedUser.username, authenticatedUser.username, 100),
    email: safeString(authenticatedUser.email, "", 254),
  };

  await fs.writeFile(path.join(commitDir, "commit.json"), JSON.stringify({
    hash,
    parent: parents[0] || null,
    parents,
    branch,
    author,
    message,
    time: time.toISOString(),
  }, null, 2));

  const changedFiles = Array.isArray(metadata.changedFiles) && metadata.changedFiles.length
    ? metadata.changedFiles.map((file) => {
      const filePath = normalizeRepositoryPath(safeString(file.path, file.filename, 1000));
      return {
      filename: path.basename(filePath),
      path: filePath,
      hash: /^[a-f0-9]{64}$/.test(file.hash || "") ? file.hash : undefined,
      status: ["added", "modified", "deleted"].includes(file.status) ? file.status : undefined,
      };
    })
    : stagedFiles.map((filePath) => ({ filename: path.basename(filePath), path: filePath, status: "added" }));
  const deletedFiles = Array.isArray(metadata.deletedFiles)
    ? metadata.deletedFiles.map((file) => normalizeRepositoryPath(safeString(file, "", 1000)))
    : [];
  const requestedSummary = metadata.summary || {};
  const summary = ["filesChanged", "additions", "deletions"].every((key) =>
    Number.isInteger(requestedSummary[key]) && requestedSummary[key] >= 0
  ) ? {
    filesChanged: requestedSummary.filesChanged,
    additions: requestedSummary.additions,
    deletions: requestedSummary.deletions,
  } : undefined;

  if (!Array.isArray(repo.pendingCommits)) repo.pendingCommits = [];
  repo.pendingCommits.push({
    hash,
    parent: parents[0] || null,
    parents,
    branch,
    storageId,
    author,
    message,
    files: changedFiles,
    deletedFiles,
    summary,
    createdAt: time,
    pushedAt: null,
  });
  await repo.save();
  await fs.rm(stagedPath, { recursive: true, force: true });
  return {
    hash, storageId, branch, parent: parents[0] || null, author,
    localHead: hash,
    remoteHead: existingBranch?.head || null,
    aheadCount: userPending.length + 1,
    behindCount: 0,
    hasStagedChanges: false,
    hasUnpushedCommits: true,
  };
}

module.exports = { commitRepo };
