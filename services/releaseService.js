const path = require("path");
const crypto = require("crypto");
const { isSensitiveRepoPath } = require("../utils/repoPath");

const MAX_ASSET_SIZE = 100 * 1024 * 1024;
const MAX_ASSETS = 20;
const MAX_TOTAL_ASSET_SIZE = 500 * 1024 * 1024;
const FORBIDDEN_ASSET_EXTENSIONS = new Set([".bat", ".cmd", ".com", ".ps1", ".scr", ".sh"]);

function releaseError(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function canManageReleases(repository, userId) {
  const id = String(userId || "");
  if (String(repository.owner?._id || repository.owner || "") === id) return true;
  return (repository.collaborators || []).some((item) => String(item.user?._id || item.user) === id && item.role === "maintainer");
}
function assertReleaseManager(repository, userId) {
  if (!canManageReleases(repository, userId)) throw releaseError(403, "Owner or maintainer access is required", "RELEASE_PERMISSION_DENIED");
}
function cleanText(value, max, label, { required = false } = {}) {
  const text = String(value || "").trim();
  if (required && !text) throw releaseError(400, `${label} is required`, `INVALID_${label.toUpperCase()}`);
  if (text.length > max) throw releaseError(400, `${label} exceeds ${max} characters`, `INVALID_${label.toUpperCase()}`);
  return text;
}
function validateAssetFile(file, currentAssets = []) {
  const name = path.basename(String(file?.originalname || "").replaceAll("\\", "/"));
  if (!name || name === "." || name === ".." || name.includes("\0")) throw releaseError(400, "Invalid asset filename", "INVALID_ASSET");
  if (isSensitiveRepoPath(name)) throw releaseError(400, "Sensitive files cannot be uploaded as release assets", "FORBIDDEN_ASSET");
  if (FORBIDDEN_ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())) throw releaseError(400, "Executable and script assets are not allowed", "FORBIDDEN_ASSET_TYPE");
  const size = Number(file?.size || 0);
  if (size <= 0 || size > MAX_ASSET_SIZE) throw releaseError(413, "Asset must be non-empty and no larger than 100 MB", "ASSET_TOO_LARGE");
  if (currentAssets.length >= MAX_ASSETS) throw releaseError(400, `A release may contain at most ${MAX_ASSETS} assets`, "TOO_MANY_ASSETS");
  if (currentAssets.some((asset) => asset.name.toLowerCase() === name.toLowerCase())) throw releaseError(409, "An asset with this filename already exists", "DUPLICATE_ASSET");
  const total = currentAssets.reduce((sum, asset) => sum + Number(asset.size || 0), 0) + size;
  if (total > MAX_TOTAL_ASSET_SIZE) throw releaseError(413, "Release assets may total at most 500 MB", "ASSET_TOTAL_TOO_LARGE");
  return { name, size, contentType: String(file.mimetype || "application/octet-stream").slice(0, 200) };
}
function safeCreator(value) {
  if (!value) return null;
  if (typeof value === "string") return { _id: value };
  return { _id: value._id, username: value.username, name: value.name, avatarUrl: value.avatarUrl };
}
function safeRelease(release) {
  const value = release?.toObject ? release.toObject() : { ...release };
  const tag = value.tag?.name ? {
    _id: value.tag._id, name: value.tag.name, targetCommitHash: value.tag.targetCommitHash,
    message: value.tag.message || "", target: value.tag.target,
  } : value.tag;
  return {
    _id: value._id, tag, title: value.title, body: value.body || "", draft: Boolean(value.draft),
    prerelease: Boolean(value.prerelease), latest: Boolean(value.latest), publishedAt: value.publishedAt,
    createdAt: value.createdAt, updatedAt: value.updatedAt, createdBy: safeCreator(value.createdBy), publishedBy: safeCreator(value.publishedBy),
    assets: (value.assets || []).map((asset) => ({
      _id: asset._id, name: asset.name, size: asset.size, contentType: asset.contentType,
      checksum: asset.checksum, downloadCount: asset.downloadCount || 0,
      uploadedBy: safeCreator(asset.uploadedBy), uploadedAt: asset.uploadedAt,
    })),
  };
}
function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

module.exports = {
  MAX_ASSETS, MAX_ASSET_SIZE, MAX_TOTAL_ASSET_SIZE, assertReleaseManager, canManageReleases,
  cleanText, releaseError, safeRelease, sha256, validateAssetFile,
};
