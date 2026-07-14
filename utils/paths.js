const path = require("path");

function normalizeRepoPath(filePath) {
  if (typeof filePath !== "string" || filePath.includes("\0")) {
    const error = new Error(`Unsafe repository file path: ${filePath}`);
    error.status = 400;
    throw error;
  }
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized
    || normalized.startsWith("/")
    || path.win32.isAbsolute(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    const error = new Error(`Unsafe repository file path: ${filePath}`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function requestedRepoPath(req) {
  const wildcard = req.params?.[0] ?? req.params?.filePath ?? req.params?.filename;
  const rawPath = Array.isArray(wildcard) ? wildcard.join("/") : wildcard;
  return normalizeRepoPath(rawPath);
}

function isSensitiveRepoPath(filePath) {
  const normalized = normalizeRepoPath(filePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  return basename === ".env"
    || (basename.startsWith(".env.") && basename !== ".env.example")
    || basename.endsWith(".pem")
    || basename.endsWith(".key")
    || basename === "service-account.json"
    || basename === "credentials.json"
    || basename.endsWith("-credentials.json")
    || basename === "id_rsa"
    || basename === "id_ed25519"
    || basename.includes("private-key")
    || basename.includes("private_key");
}

function isDefaultIgnoredRepoPath(filePath) {
  const normalized = normalizeRepoPath(filePath).toLowerCase();
  const parts = normalized.split("/");
  return parts.some((part) => [".codehub", ".git", "node_modules", "dist", "build", "coverage"].includes(part))
    || isSensitiveRepoPath(normalized);
}

function findRepositoryFile(repository, requestedPath) {
  return (repository.content || []).find((file) => {
    try {
      return normalizeRepoPath(file.path || file.filename) === requestedPath;
    } catch {
      return false;
    }
  });
}

module.exports = {
  normalizeRepoPath,
  normalizeRepositoryPath: normalizeRepoPath,
  requestedRepoPath,
  isSensitiveRepoPath,
  isDefaultIgnoredRepoPath,
  findRepositoryFile,
};
