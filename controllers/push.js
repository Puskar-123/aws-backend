const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const mongoose = require("mongoose");
const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");
const { calculateHash } = require("../utils/hash");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");
const { isDefaultIgnoredRepoPath, isSensitiveRepoPath, normalizeRepoPath } = require("../utils/repoPath");
const { detectRepositoryLanguage } = require("../services/repositoryLanguageService");
const { assertCanDirectWrite } = require("../services/branchProtectionService");
const { notifyReviewersOfNewHead } = require("../services/reviewNotificationService");

const COMMIT_METADATA = "commit.json";

async function getAllFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllFiles(fullPath));
    } else if (entry.isFile() && entry.name !== COMMIT_METADATA) {
      files.push(fullPath);
    }
  }

  return files;
}

async function getCommitTimestamp(commitPath) {
  try {
    const metadata = JSON.parse(
      await fsp.readFile(path.join(commitPath, COMMIT_METADATA), "utf8")
    );
    const timestamp = Date.parse(metadata.time);
    if (!Number.isNaN(timestamp)) return timestamp;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  return (await fsp.stat(commitPath)).mtimeMs;
}

async function findLatestCommit(commitsPath) {
  const entries = await fsp.readdir(commitsPath, { withFileTypes: true });
  const commits = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        id: entry.name,
        path: path.join(commitsPath, entry.name),
        timestamp: await getCommitTimestamp(path.join(commitsPath, entry.name)),
      }))
  );

  commits.sort((left, right) =>
    right.timestamp - left.timestamp || right.id.localeCompare(left.id)
  );
  return commits[0] || null;
}

function findCommit(repository, hash) {
  return repository.commits.find((commit) => commit.hash === hash || String(commit._id) === hash);
}

function findStoredSnapshot(repository, commit, useRepositoryContent) {
  const visited = new Set();
  let current = commit;
  while (current && !visited.has(String(current._id))) {
    visited.add(String(current._id));
    const files = (current.snapshot?.length ? current.snapshot : current.files || [])
      .filter((file) => (file.s3Key || file.storageKey) && file.status !== "deleted");
    if (files.length) return files;
    current = findCommit(repository, current.parent || current.parents?.[0]);
  }
  return useRepositoryContent ? repository.content : [];
}

async function pushRepo(req, res) {
  const { id } = req.params;
  const commitsPath = path.resolve(process.cwd(), ".myGit", id, "commits");

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID" });
    }
    const repo = await Repository.findById(id);
    if (!repo) {
      return res.status(404).json({ error: "Repository not found" });
    }

    const defaultBranch = ensureDefaultBranch(repo);
    const branchName = validateBranchName(req.body?.branch || defaultBranch.name);
    assertCanDirectWrite(repo, branchName, req.user?.id, "push", { force: Boolean(req.body?.force) });
    let branch = repo.branches.find((item) => item.name === branchName);
    if (!branch) {
      repo.branches.push({ name: branchName, head: null, isDefault: false });
      branch = repo.branches.find((item) => item.name === branchName);
    }
    let targetCommit = req.body?.head ? findCommit(repo, req.body.head) : null;
    let latestCommit;
    if (targetCommit?.storageId) {
      latestCommit = {
        id: targetCommit.storageId,
        path: path.join(commitsPath, targetCommit.storageId),
      };
      try {
        await fsp.access(latestCommit.path);
      } catch {
        latestCommit = null;
      }
    }
    if (!latestCommit) latestCommit = await findLatestCommit(commitsPath);
    if (!latestCommit) {
      return res.status(400).json({ error: "No commits to push" });
    }
    if (!targetCommit) {
      targetCommit = repo.commits.find((commit) => commit.storageId === latestCommit.id) || null;
    }

    // Each commit directory is a full snapshot. Only the newest one is needed
    // to calculate the repository's current remote state.
    const committedFiles = (await getAllFiles(latestCommit.path)).sort();
    const pushedPaths = Array.isArray(req.body?.paths)
      ? new Set(req.body.paths.map((filePath) =>
        normalizeRepoPath(String(filePath))
      ))
      : null;
    const previousSnapshot = findStoredSnapshot(
      repo,
      targetCommit,
      branchName === defaultBranch.name
    );
    const storedFiles = new Map(previousSnapshot.map((file) => [file.path, file]));
    // A branch commit is an overlay on its parent snapshot. Start with every
    // inherited file and replace only paths present in the new commit.
    const latestFiles = new Map(previousSnapshot.map((file) => [file.path, { ...file }]));
    const uploaded = [];
    const skipped = [];
    const warnings = [];

    for (const filePath of committedFiles) {
      const relativePath = normalizeRepoPath(path
        .relative(latestCommit.path, filePath)
        .split(path.sep)
        .join("/"));
      if (isDefaultIgnoredRepoPath(relativePath)) {
        warnings.push(isSensitiveRepoPath(relativePath)
          ? `Blocked protected file ${relativePath}; remove previously uploaded secrets manually.`
          : `Ignored generated path ${relativePath}.`);
        continue;
      }
      if (pushedPaths && !pushedPaths.has(relativePath)) continue;
      const filename = path.basename(filePath);

      // Hash once and reuse the digest for comparison and persistence.
      const hash = await calculateHash(filePath);
      const storedFile = storedFiles.get(relativePath);
      const storedKey = storedFile?.s3Key || storedFile?.storageKey;
      const unchanged = Boolean(
        storedFile && storedFile.hash === hash && storedKey
      );

      let s3Key;
      if (unchanged) {
        s3Key = storedKey;
        skipped.push(relativePath);
      } else {
        s3Key = `repos/${id}/commits/${latestCommit.id}/${relativePath}`;
        await s3.upload({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: fs.createReadStream(filePath),
        }).promise();
        uploaded.push(relativePath);
      }

      latestFiles.set(relativePath, {
        filename,
        path: relativePath,
        hash,
        s3Key,
        status: !storedFile ? "added" : (storedFile.hash !== hash ? "modified" : undefined),
      });
    }

    // Never upload protected files, and do not silently delete legacy remote
    // secrets. They stay hidden until the owner explicitly deletes them.
    for (const file of previousSnapshot) {
      if (isSensitiveRepoPath(file.path) && !latestFiles.has(file.path)) {
        latestFiles.set(file.path, {
          filename: file.filename,
          path: file.path,
          hash: file.hash,
          s3Key: file.s3Key || file.storageKey || file.path,
        });
        warnings.push(`Protected remote file ${file.path} was preserved and must be removed manually.`);
      }
    }

    const explicitlyDeleted = new Set([
      ...(targetCommit?.deletedFiles || []),
      ...(targetCommit?.files || []).filter((file) => file.status === "deleted").map((file) => file.path),
    ].map((filePath) => normalizeRepoPath(String(filePath))));
    explicitlyDeleted.forEach((filePath) => latestFiles.delete(filePath));

    // Only explicit delete metadata removes inherited paths.
    const deleted = previousSnapshot
      .filter((file) => !latestFiles.has(file.path))
      .map((file) => file.path);

    if (targetCommit && !targetCommit.snapshot?.length) {
      targetCommit.snapshot = [...latestFiles.values()].map((file) => ({
        filename: file.filename,
        path: file.path,
        hash: file.hash,
        s3Key: file.s3Key,
      }));
      targetCommit.files = [
        ...[...latestFiles.values()].filter((file) => file.status),
        ...deleted.map((filePath) => ({
          filename: path.basename(filePath),
          path: filePath,
          status: "deleted",
        })),
      ];
      targetCommit.deletedFiles = deleted;
      if (!targetCommit.branch) targetCommit.branch = branchName;
    }
    if (req.body?.head) branch.head = req.body.head;
    if (branchName === defaultBranch.name) repo.content = [...latestFiles.values()];
    if (branchName === defaultBranch.name) repo.language = detectRepositoryLanguage([...latestFiles.values()]);
    // Existing commit history must not be rebuilt or overwritten by push.
    await repo.save();
    await notifyReviewersOfNewHead(repo, branchName, branch.head, req.user?.id);

    return res.json({
      message: "Upload complete",
      files: repo.content,
      commits: repo.commits,
      uploaded,
      skipped,
      deleted,
      uploadedCount: uploaded.length,
      skippedCount: skipped.length,
      deletedCount: deleted.length,
      warnings: [...new Set(warnings)],
    });
  } catch (err) {
    console.error("Push failed:", err);
    return res.status(err.status || 500).json({
      error: err.status ? err.message : "Push failed",
      ...(err.code ? { code: err.code, branch: err.branch, suggestedAction: err.suggestedAction } : {}),
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
}

module.exports = {
  pushRepo,
  getAllFiles,
  findLatestCommit,
};
