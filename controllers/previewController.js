const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { findRepositoryFile, isSensitiveRepoPath, requestedRepoPath } = require("../utils/repoPath");
const { getSnapshotDescriptor } = require("./snapshotController");

const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".json", ".md", ".mdx", ".css", ".scss",
  ".html", ".txt", ".yml", ".yaml", ".xml", ".sh", ".py", ".java", ".c",
  ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql",
  ".env.example",
]);

const CONTENT_TYPES = {
  ".js": "text/javascript", ".jsx": "text/javascript", ".ts": "text/typescript",
  ".tsx": "text/typescript", ".json": "application/json", ".md": "text/markdown",
  ".mdx": "text/markdown", ".css": "text/css", ".scss": "text/x-scss",
  ".html": "text/html", ".txt": "text/plain",
  ".yml": "application/yaml", ".yaml": "application/yaml", ".xml": "application/xml",
  ".sh": "text/x-shellscript", ".py": "text/x-python", ".java": "text/x-java-source",
  ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".hpp": "text/x-c++",
  ".cs": "text/x-csharp", ".go": "text/x-go", ".rs": "text/x-rust",
  ".php": "text/x-php", ".rb": "text/x-ruby", ".sql": "application/sql",
  ".env.example": "text/plain",
};

function containsNullByte(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

async function previewFile(req, res) {
  let requestedPath;
  try {
    requestedPath = requestedRepoPath(req);
    if (isSensitiveRepoPath(requestedPath)) {
      console.warn(`Blocked preview of sensitive repository path ${requestedPath} in ${req.params.id}`);
      return res.status(403).json({
        error: "Sensitive files cannot be previewed. Remove previously uploaded secrets manually.",
      });
    }
    const repo = await getAccessibleRepository(req, req.params.id);
    const file = req.query?.branch
      ? getSnapshotDescriptor(repo, req.query.branch).files.find((item) => item.path === requestedPath)
      : findRepositoryFile(repo, requestedPath);
    if (!file) return res.status(404).json({ error: "File not found" });

    const s3Key = file.s3Key || file.storageKey || file.path;
    let data;
    try {
      data = await s3.getObject({ Bucket: S3_BUCKET, Key: s3Key }).promise();
    } catch (error) {
      console.error(`S3 preview failed for repository ${req.params.id}, path ${requestedPath}:`, error.code || error.message);
      return res.status(500).json({ error: "Unable to preview file from storage" });
    }

    const extension = requestedPath.toLowerCase().endsWith(".env.example")
      ? ".env.example"
      : path.posix.extname(requestedPath).toLowerCase();
    const contentType = data.ContentType || file.contentType || CONTENT_TYPES[extension] || "application/octet-stream";
    const textSupported = extension === ".env.example"
      || TEXT_EXTENSIONS.has(extension)
      || contentType.startsWith("text/")
      || /json|javascript|xml|yaml/.test(contentType);
    const binary = containsNullByte(data.Body) || !textSupported;

    return res.json({
      filename: path.posix.basename(requestedPath),
      path: requestedPath,
      content: binary ? null : data.Body.toString("utf8"),
      contentType,
      binary,
      previewSupported: !binary,
    });
  } catch (error) {
    if (error.status) return sendAccessError(res, error);
    console.error(`Preview failed for repository ${req.params.id}, path ${requestedPath || "unknown"}:`, error.message);
    return res.status(500).json({ error: "Unable to preview file" });
  }
}

module.exports = { previewFile, TEXT_EXTENSIONS };
