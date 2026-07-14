const path = require("path");
const { createTwoFilesPatch, structuredPatch } = require("diff");
const { normalizeRepoPath } = require("../utils/repoPath");

const MAX_INLINE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".scss", ".html", ".xml",
  ".md", ".mdx", ".txt", ".yml", ".yaml", ".sh", ".py", ".java", ".c",
  ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql",
]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".pdf",
  ".zip", ".gz", ".tar", ".rar", ".7z", ".exe", ".dll", ".woff", ".woff2",
  ".ttf", ".otf", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
]);

function isProtectedDiffPath(filePath) {
  const basename = path.posix.basename(normalizeRepoPath(filePath)).toLowerCase();
  return basename === ".env"
    || basename.startsWith(".env.")
    || basename.endsWith(".pem")
    || basename.endsWith(".key")
    || basename === "service-account.json"
    || basename === "credentials.json"
    || basename.endsWith("-credentials.json");
}

function storageKey(file) {
  if (file?.contentUnavailable) return null;
  return file?.s3Key || file?.storageKey || file?.path || null;
}

function createS3ObjectReader(s3, bucket, cache = new Map()) {
  return async (file) => {
    const key = storageKey(file);
    if (!key) return { available: false, error: "Historical file content is unavailable" };
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        try {
          const data = await s3.getObject({ Bucket: bucket, Key: key }).promise();
          return {
            available: true,
            body: Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body || ""),
            contentType: data.ContentType || "",
          };
        } catch (error) {
          return {
            available: false,
            error: ["NoSuchKey", "NotFound", "NoSuchBucket"].includes(error.code)
              ? "Historical file content is unavailable"
              : "Unable to read historical file content",
          };
        }
      })());
    }
    return cache.get(key);
  };
}

function filesEquivalent(previous, current) {
  if (previous.hash && current.hash) return previous.hash === current.hash;
  const oldKey = storageKey(previous);
  const newKey = storageKey(current);
  return Boolean(oldKey && newKey && oldKey === newKey);
}

function findRenames(removed, added) {
  const removedByHash = new Map();
  const addedByHash = new Map();
  removed.forEach((file) => {
    if (!file.hash) return;
    const matches = removedByHash.get(file.hash) || [];
    matches.push(file);
    removedByHash.set(file.hash, matches);
  });
  added.forEach((file) => {
    if (!file.hash) return;
    const matches = addedByHash.get(file.hash) || [];
    matches.push(file);
    addedByHash.set(file.hash, matches);
  });

  const renames = [];
  for (const [hash, oldMatches] of removedByHash) {
    const newMatches = addedByHash.get(hash) || [];
    if (oldMatches.length === 1 && newMatches.length === 1) {
      renames.push({ previous: oldMatches[0], current: newMatches[0] });
    }
  }
  return renames;
}

function classifyChanges(previousSnapshot, currentSnapshot) {
  const modified = [];
  const removed = [];
  const added = [];

  for (const [filePath, previous] of previousSnapshot) {
    const current = currentSnapshot.get(filePath);
    if (!current) removed.push(previous);
    else if (!filesEquivalent(previous, current)) modified.push({ previous, current, status: "modified" });
  }
  for (const [filePath, current] of currentSnapshot) {
    if (!previousSnapshot.has(filePath)) added.push(current);
  }

  const renames = findRenames(removed, added);
  const renamedOldPaths = new Set(renames.map(({ previous }) => previous.path));
  const renamedNewPaths = new Set(renames.map(({ current }) => current.path));
  return [
    ...modified,
    ...renames.map(({ previous, current }) => ({ previous, current, status: "renamed" })),
    ...added.filter((file) => !renamedNewPaths.has(file.path)).map((current) => ({ previous: null, current, status: "added" })),
    ...removed.filter((file) => !renamedOldPaths.has(file.path)).map((previous) => ({ previous, current: null, status: "deleted" })),
  ].sort((left, right) =>
    (left.current?.path || left.previous.path).localeCompare(right.current?.path || right.previous.path, undefined, { sensitivity: "base" })
  );
}

function hasNullByte(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function isTextContent(filePath, contentType, body) {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return false;
  if (hasNullByte(body)) return false;
  return TEXT_EXTENSIONS.has(extension)
    || String(contentType).startsWith("text/")
    || /json|javascript|typescript|xml|yaml|sql/.test(String(contentType));
}

function mapHunks(oldText, newText, oldPath, newPath) {
  const patch = structuredPatch(oldPath, newPath, oldText, newText, "", "", { context: 3 });
  let additions = 0;
  let deletions = 0;
  const hunks = patch.hunks.map((hunk) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines = [];
    hunk.lines.forEach((line) => {
      if (line.startsWith("\\ No newline")) return;
      const marker = line[0];
      if (marker === "+") {
        additions += 1;
        lines.push({ type: "added", content: line, oldLineNumber: null, newLineNumber: newLine++ });
      } else if (marker === "-") {
        deletions += 1;
        lines.push({ type: "removed", content: line, oldLineNumber: oldLine++, newLineNumber: null });
      } else {
        lines.push({ type: "context", content: line, oldLineNumber: oldLine++, newLineNumber: newLine++ });
      }
    });
    return {
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines,
    };
  });
  return {
    hunks,
    additions,
    deletions,
    patch: createTwoFilesPatch(oldPath, newPath, oldText, newText, "", "", { context: 3 }),
  };
}

async function readTextVersion(file, readObject, filePath, maxBytes) {
  if (!file) return { available: true, text: "", body: Buffer.alloc(0), contentType: "text/plain" };
  const extension = path.posix.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return { available: true, binary: true };
  const result = await readObject(file);
  if (!result.available) return result;
  const body = result.body || Buffer.alloc(0);
  if (body.length > maxBytes) return { available: true, tooLarge: true, size: body.length };
  if (!isTextContent(filePath, result.contentType, body)) return { available: true, binary: true };
  return { available: true, text: body.toString("utf8"), body, contentType: result.contentType };
}

async function createFileDiff(change, readObject, maxBytes) {
  const filePath = change.current?.path || change.previous.path;
  const oldPath = change.previous?.path || filePath;
  const base = {
    path: filePath,
    oldPath: change.status === "renamed" ? oldPath : undefined,
    status: change.status,
    additions: 0,
    deletions: 0,
    binary: false,
    isBinary: false,
    patch: null,
    oldContent: null,
    newContent: null,
    hunks: [],
  };

  if (isProtectedDiffPath(filePath) || isProtectedDiffPath(oldPath)) {
    return { ...base, protected: true, message: "Protected file diff hidden" };
  }

  const [previous, current] = await Promise.all([
    readTextVersion(change.previous, readObject, oldPath, maxBytes),
    readTextVersion(change.current, readObject, filePath, maxBytes),
  ]);
  if (!previous.available || !current.available) {
    return {
      ...base,
      unavailable: true,
      message: previous.error || current.error || "Historical file content is unavailable",
    };
  }
  if (previous.tooLarge || current.tooLarge) {
    return { ...base, tooLarge: true, message: "File is too large for inline diff" };
  }
  if (previous.binary || current.binary) {
    return { ...base, binary: true, isBinary: true, message: "Binary file changed" };
  }
  if (change.status === "modified" && previous.text === current.text) return null;
  return {
    ...base,
    oldContent: previous.text,
    newContent: current.text,
    ...mapHunks(previous.text, current.text, oldPath, filePath),
  };
}

async function buildCommitDiff(previousSnapshot, currentSnapshot, options) {
  const readObject = options.readObject;
  const maxBytes = options.maxBytes || MAX_INLINE_BYTES;
  const files = [];
  for (const change of classifyChanges(previousSnapshot, currentSnapshot)) {
    const file = await createFileDiff(change, readObject, maxBytes);
    if (file) files.push(file);
  }
  return {
    summary: {
      filesChanged: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    },
    files,
  };
}

module.exports = {
  BINARY_EXTENSIONS,
  MAX_INLINE_BYTES,
  TEXT_EXTENSIONS,
  buildCommitDiff,
  classifyChanges,
  createS3ObjectReader,
  filesEquivalent,
  isProtectedDiffPath,
  mapHunks,
};
