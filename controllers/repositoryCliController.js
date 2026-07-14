const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const User = require("../models/userModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { normalizeRepoPath, isDefaultIgnoredRepoPath } = require("../utils/repoPath");
const { validateBranchName, ensureDefaultBranch } = require("../utils/branches");
const { canViewRepository, getRepositoryRole, hasRepositoryPermission } = require("../services/repositoryPermissionService");
const { assertCanDirectWrite, getProtectionSummary } = require("../services/branchProtectionService");
const { detectRepositoryLanguage } = require("../services/repositoryLanguageService");
const { safeNotifyRepositoryWatchers } = require("../services/notificationService");
const { notifyReviewersOfNewHead } = require("../services/reviewNotificationService");

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
const MAX_FILE_COUNT = 500;
const MAX_COMMITS = 100;
const idOf = (value) => String(value?._id || value?.id || value || "");
const httpError = (status, message, code, extras = {}) => Object.assign(new Error(message), { status, code, ...extras });

function safeFile(file) {
  return { filename: file.filename || path.posix.basename(file.path), path: file.path, hash: file.hash, s3Key: file.s3Key || file.storageKey, size: file.size, contentType: file.contentType };
}
function cleanPath(value) {
  const filePath = normalizeRepoPath(String(value || ""));
  if (isDefaultIgnoredRepoPath(filePath)) throw httpError(403, `Protected or ignored path is not allowed: ${filePath}`, "PROTECTED_FILE", { path: filePath });
  return filePath;
}
function parseManifest(req) {
  let manifest;
  try { manifest = JSON.parse(String(req.body?.manifest || "")); } catch { throw httpError(400, "Push manifest must be valid JSON", "INVALID_PUSH"); }
  if (!manifest || !Array.isArray(manifest.commits) || !manifest.commits.length || manifest.commits.length > MAX_COMMITS) throw httpError(400, `Push must contain between 1 and ${MAX_COMMITS} commits`, "INVALID_PUSH");
  manifest.branch = validateBranchName(manifest.branch);
  return manifest;
}
async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256"); const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolve(hash.digest("hex")));
  });
}
async function cleanup(files = []) { await Promise.all(files.map((file) => fsp.rm(file.path, { force: true }).catch(() => {}))); }

function createRepositoryCliController({ RepositoryModel = Repository, UserModel = User, storage = s3, bucket = S3_BUCKET, notifyWatchers = safeNotifyRepositoryWatchers, notifyReviewers = notifyReviewersOfNewHead } = {}) {
  async function resolve(req, res) {
    try {
      const repository = await RepositoryModel.findOne({ name: req.params.name }).populate("owner", "_id username name avatarUrl");
      if (!repository || String(repository.owner?.username || "").toLowerCase() !== String(req.params.owner || "").toLowerCase()) throw httpError(404, "Repository not found", "REPOSITORY_NOT_FOUND");
      if (!canViewRepository(repository, req.user?.id)) throw httpError(req.user?.id ? 403 : 401, req.user?.id ? "You do not have access to this repository" : "Authentication required", req.user?.id ? "PERMISSION_DENIED" : "AUTH_REQUIRED");
      return res.json({ repository: { _id: repository._id, owner: repository.owner?.username, name: repository.name, visibility: repository.visibility, defaultBranch: repository.defaultBranch || "main" } });
    } catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to resolve repository", ...(error.code ? { code: error.code } : {}) }); }
  }

  async function metadata(req, res) {
    try {
      const repository = req.repository || await RepositoryModel.findById(req.params.id).populate("owner", "_id username name avatarUrl");
      if (!repository) throw httpError(404, "Repository not found", "REPOSITORY_NOT_FOUND");
      if (repository.populate && !repository.owner?.username) await repository.populate("owner", "_id username name avatarUrl");
      const defaultBranch = ensureDefaultBranch(repository);
      const role = getRepositoryRole(repository, req.user?.id);
      const branches = (repository.branches || []).map((branch) => ({ name: branch.name, head: branch.head || null, isDefault: branch.name === defaultBranch.name || branch.isDefault, protection: getProtectionSummary(repository, branch.name, req.user?.id) }));
      return res.json({ repository: { _id: repository._id, owner: repository.owner?.username || idOf(repository.owner), name: repository.name, visibility: repository.visibility, defaultBranch: defaultBranch.name }, currentUserRole: role || (repository.visibility === "public" ? "public" : null), branches, permissions: { canClone: true, canPull: true, canPush: hasRepositoryPermission(repository, req.user?.id, "write_files"), canPushToDefaultBranch: hasRepositoryPermission(repository, req.user?.id, "write_files") && !(() => { try { assertCanDirectWrite(repository, defaultBranch.name, req.user?.id, "cli_metadata"); return false; } catch { return true; } })() } });
    } catch (error) { return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load CLI metadata", ...(error.code ? { code: error.code } : {}) }); }
  }

  async function push(req, res) {
    const uploadedFiles = req.files || [];
    try {
      const manifest = parseManifest(req);
      if (uploadedFiles.length > MAX_FILE_COUNT || uploadedFiles.some((file) => file.size > MAX_FILE_SIZE) || uploadedFiles.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_SIZE) throw httpError(413, "Push exceeds the configured file limits", "FILE_TOO_LARGE");
      const repository = req.repository || await RepositoryModel.findById(req.params.id);
      if (!repository) throw httpError(404, "Repository not found", "REPOSITORY_NOT_FOUND");
      assertCanDirectWrite(repository, manifest.branch, req.user?.id, "cli_push", { force: Boolean(manifest.force) });
      const branch = (repository.branches || []).find((item) => item.name === manifest.branch);
      const firstParent = manifest.commits[0]?.parent || manifest.commits[0]?.parents?.[0] || null;
      const remoteHead = branch?.head || null;
      const expectedHead = manifest.expectedRemoteHead || null;
      if (branch && idOf(remoteHead) !== idOf(expectedHead)) throw httpError(409, "The remote branch changed. Run `codehub pull` before pushing.", "REMOTE_CHANGED", { remoteHead });
      if (!branch && expectedHead && expectedHead !== firstParent) throw httpError(409, "The branch base changed. Fetch remote branches and try again.", "REMOTE_CHANGED");
      if (!branch && firstParent && !(repository.commits || []).some((commit) => idOf(commit.hash || commit._id) === idOf(firstParent))) throw httpError(409, "The local branch is based on an unknown remote commit.", "REMOTE_CHANGED");

      const finalHash = String(manifest.commits.at(-1)?.localCommitId || manifest.commits.at(-1)?.hash || "");
      if (branch?.head === finalHash && manifest.commits.every((input) => repository.commits.some((commit) => commit.hash === (input.localCommitId || input.hash)))) return res.json({ message: "Push already applied", idempotent: true, branch: manifest.branch, head: finalHash, commitsCreated: 0 });

      const uploadByHash = new Map();
      for (const file of uploadedFiles) {
        const supplied = String(file.originalname || "").replace(/^blob-/, "");
        if (!/^[a-f0-9]{64}$/.test(supplied) || await hashFile(file.path) !== supplied) throw httpError(400, "Uploaded file hash verification failed", "HASH_MISMATCH");
        uploadByHash.set(supplied, file);
      }
      const baseCommit = firstParent ? repository.commits.find((commit) => idOf(commit.hash || commit._id) === idOf(firstParent)) : null;
      const initialFiles = baseCommit?.snapshot?.length ? baseCommit.snapshot : (branch?.name === (repository.defaultBranch || "main") ? repository.content : []);
      let snapshot = new Map((initialFiles || []).map((file) => [file.path, safeFile(file)]));
      let parent = branch ? remoteHead : firstParent;
      const commitDocuments = [];
      const existingHashes = new Set((repository.commits || []).map((commit) => commit.hash));
      const actor = await UserModel.findById(req.user.id).select("_id username name").lean();
      if (!actor) throw httpError(401, "Authentication required", "AUTH_REQUIRED");

      for (const input of manifest.commits) {
        const hash = String(input.localCommitId || input.hash || "");
        if (!/^[a-f0-9]{64}$/.test(hash)) throw httpError(400, "Every commit requires a SHA-256 localCommitId", "INVALID_COMMIT");
        if (existingHashes.has(hash)) throw httpError(409, `Commit ${hash.slice(0, 8)} already exists on another remote state`, "REMOTE_CHANGED");
        if (idOf(input.parent || input.parents?.[0]) !== idOf(parent)) throw httpError(409, "Local commit ancestry does not match the remote branch", "REMOTE_CHANGED");
        const changes = Array.isArray(input.changes) ? input.changes : [];
        if (!changes.length) throw httpError(400, "Empty commits are not supported", "EMPTY_COMMIT");
        const storedChanges = [];
        for (const change of changes) {
          const filePath = cleanPath(change.path);
          const status = String(change.type || change.status || "");
          if (status === "deleted") { snapshot.delete(filePath); storedChanges.push({ filename: path.posix.basename(filePath), path: filePath, status: "deleted" }); continue; }
          if (!["added", "modified"].includes(status) || !/^[a-f0-9]{64}$/.test(String(change.hash || ""))) throw httpError(400, `Invalid change metadata for ${filePath}`, "INVALID_COMMIT");
          const localFile = uploadByHash.get(change.hash);
          if (!localFile) throw httpError(400, `Missing uploaded content for ${filePath}`, "MISSING_FILE");
          const s3Key = `repos/${repository._id}/commits/${hash}/${filePath}`;
          await storage.upload({ Bucket: bucket, Key: s3Key, Body: fs.createReadStream(localFile.path), ContentType: localFile.mimetype || "application/octet-stream" }).promise();
          const stored = { filename: path.posix.basename(filePath), path: filePath, hash: change.hash, s3Key, size: localFile.size, contentType: localFile.mimetype || "application/octet-stream" };
          snapshot.set(filePath, stored); storedChanges.push({ ...stored, status });
        }
        const message = String(input.message || "").trim();
        if (!message || message.length > 500) throw httpError(400, "Commit message must contain 1 to 500 characters", "INVALID_COMMIT");
        const time = input.createdAt && !Number.isNaN(Date.parse(input.createdAt)) ? new Date(input.createdAt) : new Date();
        commitDocuments.push({ hash, parent: parent || null, parents: parent ? [parent] : [], branch: manifest.branch, author: { name: actor.username || actor.name || "Unknown", email: "" }, message, files: storedChanges, deletedFiles: storedChanges.filter((file) => file.status === "deleted").map((file) => file.path), snapshot: [...snapshot.values()], summary: { filesChanged: storedChanges.length, additions: 0, deletions: 0 }, time });
        parent = hash; existingHashes.add(hash);
      }

      const filter = { _id: repository._id };
      const update = { $push: { commits: { $each: commitDocuments } }, $set: {} };
      if (branch) { filter.branches = { $elemMatch: { name: manifest.branch, head: remoteHead } }; update.$set["branches.$[pushedBranch].head"] = parent; }
      else { filter["branches.name"] = { $ne: manifest.branch }; update.$push.branches = { name: manifest.branch, head: parent, isDefault: false }; }
      if (manifest.branch === (repository.defaultBranch || "main")) { update.$set.content = [...snapshot.values()]; update.$set.language = detectRepositoryLanguage([...snapshot.values()]); }
      if (!Object.keys(update.$set).length) delete update.$set;
      const saved = await RepositoryModel.findOneAndUpdate(filter, update, { new: true, ...(branch ? { arrayFilters: [{ "pushedBranch.name": manifest.branch }] } : {}) });
      if (!saved) throw httpError(409, "The remote branch changed while the push was being finalized.", "REMOTE_CHANGED");
      await notifyWatchers(saved, { actor: req.user.id, type: "commit", title: `${actor.username || "A contributor"} pushed ${commitDocuments.length} commit${commitDocuments.length === 1 ? "" : "s"}`, message: commitDocuments.at(-1).message, url: `/repo/${saved._id}?branch=${encodeURIComponent(manifest.branch)}`, eventKey: `cli-push:${saved._id}:${parent}`, metadata: { branch: manifest.branch, commit: parent } });
      await notifyReviewers(saved, manifest.branch, parent, req.user.id);
      return res.status(201).json({ message: "Push completed successfully", branch: manifest.branch, head: parent, commitsCreated: commitDocuments.length, filesUploaded: uploadByHash.size });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to push commits", ...(error.code ? { code: error.code } : {}), ...(error.remoteHead !== undefined ? { remoteHead: error.remoteHead } : {}), ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}) });
    } finally { await cleanup(uploadedFiles); }
  }

  return { resolve, metadata, push };
}

module.exports = { MAX_FILE_SIZE, MAX_TOTAL_SIZE, MAX_FILE_COUNT, createRepositoryCliController, ...createRepositoryCliController() };
