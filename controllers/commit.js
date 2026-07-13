const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const { validateBranchName } = require("../utils/branches");
const { normalizeRepositoryPath } = require("../utils/paths");

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
  const repoPath = path.resolve(process.cwd(), ".myGit", repoId);
  const stagedPath = path.join(repoPath, "staging");
  const commitsPath = path.join(repoPath, "commits");
  const storageId = uuidv4();
  const commitDir = path.join(commitsPath, storageId);
  await fs.mkdir(commitDir, { recursive: true });
  await copyRecursive(stagedPath, commitDir);

  const hash = /^[a-f0-9]{64}$/.test(metadata.hash || "") ? metadata.hash : storageId;
  if (!repo.branches?.length) {
    repo.branches = [{ name: "main", head: null, isDefault: true }];
  }
  const existingBranch = repo.branches.find((item) => item.name === branch);
  const inferredParent = existingBranch?.head ? safeString(existingBranch.head, "", 128) : "";
  const parents = Array.isArray(metadata.parents)
    ? metadata.parents.map((parent) => safeString(parent, "", 128)).filter(Boolean).slice(0, 2)
    : (metadata.parent
      ? [safeString(metadata.parent, "", 128)]
      : (inferredParent ? [inferredParent] : []));
  const time = metadata.time && !Number.isNaN(Date.parse(metadata.time))
    ? new Date(metadata.time)
    : new Date();
  const author = {
    name: safeString(metadata.author?.name, "Unknown", 100),
    email: safeString(metadata.author?.email, "", 254),
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

  const changedFiles = Array.isArray(metadata.changedFiles)
    ? metadata.changedFiles.map((file) => {
      const filePath = normalizeRepositoryPath(safeString(file.path, file.filename, 1000));
      return {
      filename: path.basename(filePath),
      path: filePath,
      hash: /^[a-f0-9]{64}$/.test(file.hash || "") ? file.hash : undefined,
      status: ["added", "modified", "deleted"].includes(file.status) ? file.status : undefined,
      };
    })
    : [];
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

  repo.commits.push({
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
    time,
  });

  let branchRef = repo.branches.find((item) => item.name === branch);
  if (!branchRef) {
    repo.branches.push({ name: branch, head: hash, isDefault: false });
  } else {
    branchRef.head = hash;
  }
  await repo.save();
  return { hash, storageId, branch };
}

module.exports = { commitRepo };
