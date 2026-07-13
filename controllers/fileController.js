const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { findRepositoryFile, requestedRepoPath } = require("../utils/repoPath");

function safeDownloadName(filePath) {
  return path.posix.basename(filePath).replace(/["\r\n]/g, "_");
}

async function getFile(req, res) {
  let requestedPath;
  try {
    requestedPath = requestedRepoPath(req);
    const repo = await getAccessibleRepository(req, req.params.id);
    const file = findRepositoryFile(repo, requestedPath);
    if (!file) return res.status(404).json({ error: "File not found" });

    const s3Key = file.s3Key || file.storageKey || file.path;
    let data;
    try {
      data = await s3.getObject({ Bucket: S3_BUCKET, Key: s3Key }).promise();
    } catch (error) {
      console.error(`S3 download failed for repository ${req.params.id}, path ${requestedPath}:`, error.code || error.message);
      return res.status(500).json({ error: "Unable to download file from storage" });
    }

    const filename = safeDownloadName(requestedPath);
    res.setHeader("Content-Type", data.ContentType || file.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.send(data.Body);
  } catch (error) {
    if (error.status) return sendAccessError(res, error);
    console.error(`Download failed for repository ${req.params.id}, path ${requestedPath || "unknown"}:`, error.message);
    return res.status(500).json({ error: "Unable to download file" });
  }
}

module.exports = { getFile, safeDownloadName };
