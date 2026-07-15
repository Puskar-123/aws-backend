const yazl = require("yazl");
const { reconstructSnapshot } = require("./snapshotService");
const { isDefaultIgnoredRepoPath, normalizeRepoPath } = require("../utils/repoPath");

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

function archiveError(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function storageBody(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string" || value instanceof Uint8Array) return Buffer.from(value);
  throw archiveError(502, "Stored repository content is unavailable", "ARCHIVE_CONTENT_UNAVAILABLE");
}
function safeArchivePrefix(repositoryName, tagName) {
  const clean = (value) => String(value || "source").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "source";
  return `${clean(repositoryName)}-${clean(tagName)}`;
}
async function buildSourceArchive({ repository, descriptor, tagName, s3, bucket }) {
  const warnings = [];
  const snapshot = reconstructSnapshot(repository, descriptor, { warnings });
  const entries = [];
  let total = 0;
  for (const file of snapshot.values()) {
    let filePath;
    try { filePath = normalizeRepoPath(file.path || file.filename); } catch { continue; }
    if (isDefaultIgnoredRepoPath(filePath)) continue;
    const key = file.s3Key || file.storageKey;
    if (!key || file.contentUnavailable) continue;
    const object = await s3.getObject({ Bucket: bucket, Key: key }).promise();
    const body = storageBody(object.Body);
    total += body.length;
    if (total > MAX_ARCHIVE_BYTES) throw archiveError(413, "Source archive exceeds the 200 MB limit", "ARCHIVE_TOO_LARGE");
    entries.push({ path: filePath, body });
  }
  const archive = new yazl.ZipFile();
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("end", resolve);
    archive.outputStream.on("error", reject);
  });
  const prefix = safeArchivePrefix(repository.name, tagName);
  for (const entry of entries) archive.addBuffer(entry.body, `${prefix}/${entry.path}`, { compress: true });
  archive.end();
  await completed;
  return { body: Buffer.concat(chunks), filename: `${prefix}.zip`, warnings, fileCount: entries.length };
}

module.exports = { MAX_ARCHIVE_BYTES, buildSourceArchive, safeArchivePrefix, storageBody };
