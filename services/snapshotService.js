const path = require("path");
const { normalizeRepoPath } = require("../utils/repoPath");

function commitValue(commit) {
  return commit?.toObject ? commit.toObject() : (commit || {});
}

function commitIdentity(commit, index) {
  const value = commitValue(commit);
  return String(value.hash || value._id || `legacy-${index + 1}`);
}

function getCommitDescriptors(repository) {
  return (repository.commits || []).map((commit, index) => ({
    commit: commitValue(commit),
    index,
    id: commitIdentity(commit, index),
  }));
}

function findCommitDescriptor(repository, identifier) {
  const requested = String(identifier || "");
  return getCommitDescriptors(repository).find(({ commit, id }) =>
    id === requested || String(commit.hash || "") === requested || String(commit._id || "") === requested
  ) || null;
}

function getParentCommitDescriptor(repository, descriptor) {
  if (!descriptor) return { descriptor: null, missingParent: null };
  const commits = getCommitDescriptors(repository);
  const parentId = descriptor.commit.parent || descriptor.commit.parents?.[0];
  if (parentId) {
    const parent = commits.find(({ commit, id }) =>
      id === String(parentId)
      || String(commit.hash || "") === String(parentId)
      || String(commit._id || "") === String(parentId)
    );
    return { descriptor: parent || null, missingParent: parent ? null : String(parentId) };
  }

  const hasExplicitParentMetadata = Object.prototype.hasOwnProperty.call(descriptor.commit, "parent")
    || Object.prototype.hasOwnProperty.call(descriptor.commit, "parents");
  if (hasExplicitParentMetadata) {
    return { descriptor: null, missingParent: null };
  }

  // Legacy commits did not record parent hashes. MongoDB commit arrays are append-only,
  // so the immediately preceding entry is their safest compatible parent.
  return {
    descriptor: descriptor.index > 0 ? commits[descriptor.index - 1] : null,
    missingParent: null,
  };
}

function repositoryRelativePath(repository, file) {
  const rawPath = String(file.path || file.filename || "").replaceAll("\\", "/");
  const legacyPrefix = `${repository._id}/`;
  const relativePath = !file.s3Key && !file.storageKey && rawPath.startsWith(legacyPrefix)
    ? rawPath.slice(legacyPrefix.length)
    : rawPath;
  return normalizeRepoPath(relativePath);
}

function normalizeSnapshotFile(repository, file) {
  const value = file?.toObject ? file.toObject() : (file || {});
  const sourcePath = String(value.path || value.filename || "").replaceAll("\\", "/");
  const normalizedPath = repositoryRelativePath(repository, value);
  return {
    ...value,
    filename: path.posix.basename(normalizedPath),
    path: normalizedPath,
    s3Key: value.s3Key || value.storageKey || sourcePath || undefined,
  };
}

function safeSnapshotFile(repository, file, warnings) {
  try {
    return normalizeSnapshotFile(repository, file);
  } catch {
    warnings.push(`Ignored unsafe historical file path: ${file?.path || file?.filename || "unknown"}`);
    return null;
  }
}

function isLegacyFullSnapshot(commit) {
  const files = commit.files || [];
  return files.length > 0
    && files.every((file) => !file.status)
    && (!commit.storageId || files.every((file) => file.s3Key || file.storageKey));
}

function fullSnapshotFiles(commit) {
  if (commit.snapshot?.length) return commit.snapshot;
  return isLegacyFullSnapshot(commit) ? (commit.files || []) : null;
}

function setIncrementalFile(snapshot, repository, rawFile, warnings) {
  const file = safeSnapshotFile(repository, rawFile, warnings);
  if (!file) return;
  if (rawFile.status === "deleted") {
    snapshot.delete(file.path);
    return;
  }

  const previous = snapshot.get(file.path);
  const hasStoredContent = Boolean(rawFile.s3Key || rawFile.storageKey);
  const canReuseStoredContent = previous
    && rawFile.hash
    && previous.hash === rawFile.hash;
  snapshot.set(file.path, {
    ...previous,
    ...file,
    s3Key: hasStoredContent || canReuseStoredContent ? (file.s3Key || previous?.s3Key) : undefined,
    storageKey: hasStoredContent || canReuseStoredContent ? (file.storageKey || previous?.storageKey) : undefined,
    contentUnavailable: !hasStoredContent && !canReuseStoredContent,
  });
}

function reconstructSnapshot(repository, descriptor, options = {}) {
  const cache = options.cache || new Map();
  const warnings = options.warnings || [];
  const visiting = options.visiting || new Set();
  if (!descriptor) return new Map();
  if (cache.has(descriptor.id)) return cache.get(descriptor.id);
  if (visiting.has(descriptor.id)) {
    warnings.push(`Commit parent cycle detected at ${descriptor.id}`);
    return new Map();
  }
  visiting.add(descriptor.id);

  const commit = descriptor.commit;
  const fullFiles = fullSnapshotFiles(commit);
  let snapshot;

  if (fullFiles) {
    snapshot = new Map();
    fullFiles.forEach((rawFile) => {
      const file = safeSnapshotFile(repository, rawFile, warnings);
      if (file && rawFile.status !== "deleted") snapshot.set(file.path, file);
    });
  } else {
    const parent = getParentCommitDescriptor(repository, descriptor);
    if (parent.missingParent) {
      warnings.push(`Parent commit ${parent.missingParent} is unavailable`);
    }
    snapshot = new Map(reconstructSnapshot(repository, parent.descriptor, {
      cache,
      warnings,
      visiting,
    }));

    (commit.files || []).forEach((file) => setIncrementalFile(snapshot, repository, file, warnings));
    (commit.deletedFiles || []).forEach((filePath) => {
      try {
        snapshot.delete(normalizeRepoPath(filePath));
      } catch {
        warnings.push(`Ignored unsafe deleted file path: ${filePath}`);
      }
    });
  }

  visiting.delete(descriptor.id);
  cache.set(descriptor.id, snapshot);
  return snapshot;
}

module.exports = {
  commitIdentity,
  commitValue,
  findCommitDescriptor,
  getCommitDescriptors,
  getParentCommitDescriptor,
  normalizeSnapshotFile,
  reconstructSnapshot,
};
