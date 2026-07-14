const crypto = require("crypto");
const path = require("path");
const Repository = require("../models/repoModel");
const User = require("../models/userModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getBranchSnapshot } = require("../services/branchService");
const { safeNotifyRepositoryWatchers } = require("../services/notificationService");
const { validateBranchName } = require("../utils/branches");
const { isSensitiveRepoPath, normalizeRepoPath } = require("../utils/repoPath");
const { detectRepositoryLanguage } = require("../services/repositoryLanguageService");
const { assertCanDirectWrite } = require("../services/branchProtectionService");

const MAX_EDIT_BYTES = 512 * 1024;
const EDITABLE_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".jsx", ".ts", ".tsx", ".css", ".scss",
  ".html", ".xml", ".yml", ".yaml", ".properties", ".ini", ".py", ".java",
  ".c", ".cpp", ".h", ".hpp", ".go", ".rs", ".php", ".rb", ".sh", ".sql",
]);
const EDITABLE_NAMES = new Set([".gitignore", ".env.example"]);

function editError(status, message) { return Object.assign(new Error(message), { status }); }
function isEditablePath(filePath) {
  const normalized = normalizeRepoPath(filePath);
  if (isSensitiveRepoPath(normalized)) return false;
  const basename = path.posix.basename(normalized).toLowerCase();
  return EDITABLE_NAMES.has(basename) || EDITABLE_EXTENSIONS.has(path.posix.extname(basename));
}
function hasNullByte(buffer) { return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0); }
function safeFile(file) {
  return {
    filename: file.filename || path.posix.basename(file.path),
    path: file.path,
    hash: file.hash,
    s3Key: file.s3Key || file.storageKey,
    storageKey: file.storageKey,
    size: file.size,
    contentType: file.contentType,
  };
}

function createFileEditController({
  RepoModel = Repository,
  UserModel = User,
  storage = s3,
  bucket = S3_BUCKET,
  notify = safeNotifyRepositoryWatchers,
} = {}) {
  async function context(req) {
    const repository = await RepoModel.findById(req.repository._id);
    if (!repository) throw editError(404, "Repository not found");
    const branchName = validateBranchName(req.body?.branch || req.query?.branch || repository.defaultBranch || "main");
    const snapshot = getBranchSnapshot(repository, branchName);
    if (!snapshot) throw editError(404, `Branch '${branchName}' does not exist`);
    let filePath;
    try { filePath = normalizeRepoPath(req.body?.path || req.query?.path); }
    catch { throw editError(400, "Invalid repository file path"); }
    if (isSensitiveRepoPath(filePath)) throw editError(403, "Protected files cannot be edited in the browser");
    if (!isEditablePath(filePath)) throw editError(415, "This file type cannot be edited in the browser");
    const file = snapshot.files.find((item) => item.path === filePath);
    if (!file) throw editError(404, "File not found in branch snapshot");
    if (Number(file.size) > MAX_EDIT_BYTES) throw editError(413, "This file is too large to edit in the browser.");
    return { repository, branchName, snapshot, filePath, file };
  }

  async function read(req, res) {
    try {
      const value = await context(req);
      const objectKey = value.file.s3Key || value.file.storageKey || value.file.path;
      if (typeof storage.headObject === "function") {
        const metadata = await storage.headObject({ Bucket: bucket, Key: objectKey }).promise();
        if (Number(metadata.ContentLength) > MAX_EDIT_BYTES) throw editError(413, "This file is too large to edit in the browser.");
      }
      const data = await storage.getObject({ Bucket: bucket, Key: objectKey }).promise();
      const body = Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body || "");
      if (body.length > MAX_EDIT_BYTES) throw editError(413, "This file is too large to edit in the browser.");
      if (hasNullByte(body)) throw editError(415, "Binary files cannot be edited in the browser");
      return res.json({
        file: { path: value.filePath, branch: value.branchName, size: body.length, contentType: data.ContentType || value.file.contentType || "text/plain" },
        content: body.toString("utf8"),
        baseCommit: value.snapshot.branch.head || null,
        maxBytes: MAX_EDIT_BYTES,
      });
    } catch (error) {
      if (!error.status) console.error(`Editor load failed for repository ${req.params.id}:`, error.message);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load file editor" });
    }
  }

  async function update(req, res) {
    try {
      if (typeof req.body?.content !== "string") throw editError(400, "File content is required");
      const commitMessage = String(req.body?.commitMessage || "").trim();
      if (!commitMessage) throw editError(400, "Commit message is required");
      if (commitMessage.length > 500) throw editError(400, "Commit message must be 500 characters or fewer");
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, "baseCommit")) throw editError(400, "baseCommit is required");
      const content = Buffer.from(req.body.content, "utf8");
      if (content.length > MAX_EDIT_BYTES) throw editError(413, "This file is too large to edit in the browser.");
      if (hasNullByte(content)) throw editError(415, "Binary files cannot be edited in the browser");
      const value = await context(req);
      assertCanDirectWrite(value.repository, value.branchName, req.user.id, "browser_edit");
      const currentHead = value.snapshot.branch.head || null;
      const requestedHead = req.body.baseCommit || null;
      if (String(currentHead || "") !== String(requestedHead || "")) {
        throw editError(409, "The file changed after you opened it. Reload before saving.");
      }

      const fileHash = crypto.createHash("sha256").update(content).digest("hex");
      if (fileHash === value.file.hash) throw editError(400, "The file has no changes");
      const commitHash = crypto.randomUUID();
      const contentType = value.file.contentType || "text/plain; charset=utf-8";
      const key = `repos/${value.repository._id}/commits/${commitHash}/${value.filePath}`;
      await storage.putObject({ Bucket: bucket, Key: key, Body: content, ContentType: contentType }).promise();
      const changedFile = {
        filename: path.posix.basename(value.filePath), path: value.filePath, hash: fileHash,
        s3Key: key, size: content.length, contentType, status: "modified",
      };
      const nextSnapshot = value.snapshot.files.map((file) => file.path === value.filePath ? changedFile : safeFile(file));
      let author = { name: "CodeHub user", email: "" };
      const user = await UserModel.findById(req.user.id).select("username name email");
      if (user) author = { name: user.username || user.name || "CodeHub user", email: user.email || "" };
      const time = new Date();
      const commitDocument = {
        hash: commitHash,
        parent: currentHead,
        parents: currentHead ? [currentHead] : [],
        branch: value.branchName,
        author,
        message: commitMessage,
        files: [changedFile],
        snapshot: nextSnapshot,
        summary: { filesChanged: 1, additions: 0, deletions: 0 },
        time,
      };
      const branch = value.repository.branches.find((item) => item.name === value.branchName);
      const updates = {
        $push: { commits: commitDocument },
        $set: { "branches.$[editedBranch].head": commitHash },
      };
      if (branch.isDefault || value.repository.defaultBranch === branch.name) {
        updates.$set.content = nextSnapshot;
        updates.$set.language = detectRepositoryLanguage(nextSnapshot);
      }
      let savedRepository;
      if (typeof RepoModel.findOneAndUpdate === "function") {
        savedRepository = await RepoModel.findOneAndUpdate(
          { _id: value.repository._id, branches: { $elemMatch: { name: value.branchName, head: currentHead } } },
          updates,
          { new: true, arrayFilters: [{ "editedBranch.name": value.branchName }] },
        );
        if (!savedRepository) throw editError(409, "The file changed after you opened it. Reload before saving.");
      } else {
        value.repository.commits.push(commitDocument);
        branch.head = commitHash;
        if (branch.isDefault || value.repository.defaultBranch === branch.name) {
          value.repository.content = nextSnapshot;
          value.repository.language = detectRepositoryLanguage(nextSnapshot);
        }
        await value.repository.save();
        savedRepository = value.repository;
      }

      await notify(savedRepository, {
        actor: req.user.id,
        type: "commit",
        title: `New commit in ${savedRepository.name}`,
        message: `${author.name} committed: ${commitMessage}`,
        url: `/repo/${savedRepository._id}?branch=${encodeURIComponent(value.branchName)}`,
        eventKey: `commit:${savedRepository._id}:${commitHash}`,
        metadata: { commit: commitHash, branch: value.branchName },
      });
      return res.json({
        message: "File updated successfully",
        file: { path: value.filePath, branch: value.branchName },
        commit: { hash: commitHash, message: commitMessage, createdAt: time },
      });
    } catch (error) {
      if (!error.status) console.error(`Browser edit failed for repository ${req.params.id}:`, error.message);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to update file", ...(error.code ? { code: error.code, branch: error.branch, suggestedAction: error.suggestedAction } : {}) });
    }
  }

  return { read, update };
}

module.exports = { EDITABLE_EXTENSIONS, MAX_EDIT_BYTES, createFileEditController, isEditablePath, ...createFileEditController() };
