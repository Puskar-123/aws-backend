const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { findRepositoryFile, normalizeRepoPath, requestedRepoPath } = require("../utils/repoPath");
const { assertCanDirectWrite } = require("../services/branchProtectionService");

function destinationPath(oldPath, newName) {
  if (typeof newName !== "string" || !newName.trim()) {
    const error = new Error("A new filename or path is required");
    error.status = 400;
    throw error;
  }
  const candidate = newName.includes("/") || newName.includes("\\")
    ? newName
    : path.posix.join(path.posix.dirname(oldPath), newName);
  return normalizeRepoPath(candidate);
}

function renamedS3Key(oldKey, oldPath, newPath, repositoryId) {
  if (oldKey === oldPath) return newPath;
  if (oldKey.endsWith(`/${oldPath}`)) return `${oldKey.slice(0, -oldPath.length)}${newPath}`;
  return `repos/${repositoryId}/files/${newPath}`;
}

function copySource(bucket, key) {
  return `${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function deleteFile(req, res) {
  let requestedPath;
  try {
    requestedPath = requestedRepoPath(req);
    const repo = req.repository || await getAccessibleRepository(req, req.params.id, { write: true });
    assertCanDirectWrite(repo, repo.defaultBranch || "main", req.user?.id, "delete_file");
    const file = findRepositoryFile(repo, requestedPath);
    if (!file) return res.status(404).json({ error: "File not found" });

    const s3Key = file.s3Key || file.storageKey || file.path;
    try {
      await s3.deleteObject({ Bucket: S3_BUCKET, Key: s3Key }).promise();
    } catch (error) {
      console.error(`S3 delete failed for repository ${req.params.id}, path ${requestedPath}:`, error.code || error.message);
      return res.status(500).json({ error: "Unable to delete file from storage" });
    }

    repo.content = repo.content.filter((item) => item !== file);
    await repo.save();
    return res.json({ success: true, message: `Deleted ${requestedPath}`, path: requestedPath });
  } catch (error) {
    if (error.status) return sendAccessError(res, error);
    console.error(`Delete failed for repository ${req.params.id}, path ${requestedPath || "unknown"}:`, error.message);
    return res.status(500).json({ error: "Unable to delete file" });
  }
}

async function renameFile(req, res) {
  let requestedPath;
  try {
    requestedPath = requestedRepoPath(req);
    const repo = req.repository || await getAccessibleRepository(req, req.params.id, { write: true });
    assertCanDirectWrite(repo, repo.defaultBranch || "main", req.user?.id, "rename_file");
    const file = findRepositoryFile(repo, requestedPath);
    if (!file) return res.status(404).json({ error: "File not found" });

    const newPath = destinationPath(requestedPath, req.body?.newPath || req.body?.newName);
    if (newPath === requestedPath) return res.status(400).json({ error: "The new path is unchanged" });
    if (findRepositoryFile(repo, newPath)) {
      return res.status(409).json({ error: `A file already exists at ${newPath}` });
    }

    const oldKey = file.s3Key || file.storageKey || file.path;
    const newKey = renamedS3Key(oldKey, requestedPath, newPath, req.params.id);
    try {
      await s3.copyObject({
        Bucket: S3_BUCKET,
        CopySource: copySource(S3_BUCKET, oldKey),
        Key: newKey,
      }).promise();
      await s3.deleteObject({ Bucket: S3_BUCKET, Key: oldKey }).promise();
    } catch (error) {
      console.error(`S3 rename failed for repository ${req.params.id}, ${requestedPath} -> ${newPath}:`, error.code || error.message);
      return res.status(500).json({ error: "Unable to rename file in storage" });
    }

    file.filename = path.posix.basename(newPath);
    file.path = newPath;
    file.s3Key = newKey;
    if (file.storageKey !== undefined) file.storageKey = newKey;
    await repo.save();
    return res.json({
      success: true,
      message: `Renamed ${requestedPath} to ${newPath}`,
      file: { filename: file.filename, path: file.path, s3Key: file.s3Key },
    });
  } catch (error) {
    if (error.status) return sendAccessError(res, error);
    console.error(`Rename failed for repository ${req.params.id}, path ${requestedPath || "unknown"}:`, error.message);
    return res.status(500).json({ error: "Unable to rename file" });
  }
}

module.exports = {
  deleteFile,
  renameFile,
  destinationPath,
  renamedS3Key,
};
