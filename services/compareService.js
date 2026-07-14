const { buildCommitDiff, createS3ObjectReader, filesEquivalent, isProtectedDiffPath } = require("./diffService");
const { branchByName, getBranchSnapshot, normalizeCommit } = require("./branchService");
const { findCommitDescriptor, getParentCommitDescriptor, reconstructSnapshot } = require("./snapshotService");
const { ensureDefaultBranch } = require("../utils/branches");

const MAX_ANCESTRY_COMMITS = 2000;

function descriptorAliases(descriptor) {
  if (!descriptor) return [];
  return [...new Set([
    descriptor.id,
    descriptor.commit.hash,
    descriptor.commit._id,
  ].filter(Boolean).map(String))];
}

function hasExplicitParentMetadata(commit) {
  return (Object.prototype.hasOwnProperty.call(commit, "parent") && commit.parent !== undefined)
    || (Array.isArray(commit.parents) && commit.parents.length > 0);
}

function traceAncestry(repository, head, limit = MAX_ANCESTRY_COMMITS) {
  if (!head) return { available: false, descriptors: [], aliases: new Set() };
  const descriptors = [];
  const aliases = new Set();
  const visited = new Set();
  let current = findCommitDescriptor(repository, head);
  if (!current) return { available: false, descriptors, aliases };

  while (current && descriptors.length < limit) {
    if (visited.has(current.id)) return { available: false, descriptors, aliases, cyclic: true };
    visited.add(current.id);
    descriptors.push(current);
    descriptorAliases(current).forEach((alias) => aliases.add(alias));
    const parentId = current.commit.parent || current.commit.parents?.[0];
    if (!parentId) {
      return hasExplicitParentMetadata(current.commit)
        ? { available: true, descriptors, aliases }
        : { available: false, descriptors, aliases };
    }
    const parent = getParentCommitDescriptor(repository, current);
    if (!parent.descriptor || parent.missingParent) return { available: false, descriptors, aliases };
    current = parent.descriptor;
  }
  return { available: !current, descriptors, aliases, truncated: Boolean(current) };
}

function findMergeBase(baseTrace, compareTrace) {
  if (!baseTrace.available || !compareTrace.available) return null;
  return compareTrace.descriptors.find((descriptor) =>
    descriptorAliases(descriptor).some((alias) => baseTrace.aliases.has(alias))
  ) || null;
}

function uniqueDescriptors(trace, otherAliases) {
  return trace.descriptors.filter((descriptor) =>
    !descriptorAliases(descriptor).some((alias) => otherAliases.has(alias))
  );
}

function safeSnapshotMap(snapshot) {
  const map = new Map();
  for (const file of snapshot?.files || []) {
    try {
      if (!isProtectedDiffPath(file.path)) map.set(file.path, file);
    } catch {
      // Unsafe historical paths are deliberately excluded.
    }
  }
  return map;
}

function conflictForFile(file, baseSnapshot, compareSnapshot, mergeSnapshot) {
  if (!mergeSnapshot) return { conflict: false };
  if (file.status === "renamed") return { conflict: false };
  const oldPath = file.oldPath || file.path;
  const mergeFile = mergeSnapshot.get(oldPath) || mergeSnapshot.get(file.path) || null;
  const baseFile = baseSnapshot.get(oldPath) || baseSnapshot.get(file.path) || null;
  const compareFile = compareSnapshot.get(file.path) || null;
  const differs = (value, ancestor) => {
    if (!value && !ancestor) return false;
    if (!value || !ancestor) return true;
    return !filesEquivalent(value, ancestor);
  };
  const baseChanged = differs(baseFile, mergeFile);
  const compareChanged = differs(compareFile, mergeFile);
  if (!baseChanged || !compareChanged) return { conflict: false };
  if (baseFile && compareFile && filesEquivalent(baseFile, compareFile)) return { conflict: false };
  if (!baseFile || !compareFile) return { conflict: true, conflictReason: "delete_modify" };
  return { conflict: true, conflictReason: "both_modified" };
}

function comparisonCommit(repository, descriptor, defaultBranch) {
  const commit = normalizeCommit(repository, descriptor);
  return {
    id: descriptor.id,
    hash: commit.hash,
    message: commit.message,
    author: commit.author,
    createdAt: commit.time,
    parent: commit.parent,
    branch: commit.branch || defaultBranch,
  };
}

async function compareRepository(repository, baseName, compareName, options) {
  const defaultBranch = ensureDefaultBranch(repository).name;
  const baseBranch = branchByName(repository, baseName);
  const compareBranch = branchByName(repository, compareName);
  if (!baseBranch) {
    const error = new Error(`Base branch '${baseName}' not found`);
    error.status = 404;
    throw error;
  }
  if (!compareBranch) {
    const error = new Error(`Compare branch '${compareName}' not found`);
    error.status = 404;
    throw error;
  }

  const baseSnapshotResult = getBranchSnapshot(repository, baseName);
  const compareSnapshotResult = getBranchSnapshot(repository, compareName);
  const baseSnapshot = safeSnapshotMap(baseSnapshotResult);
  const compareSnapshot = safeSnapshotMap(compareSnapshotResult);
  const baseTrace = traceAncestry(repository, baseBranch.head);
  const compareTrace = traceAncestry(repository, compareBranch.head);
  const ancestryAvailable = baseTrace.available && compareTrace.available;
  const mergeDescriptor = findMergeBase(baseTrace, compareTrace);
  const mergeSnapshot = mergeDescriptor
    ? new Map([...reconstructSnapshot(repository, mergeDescriptor).entries()].filter(([filePath]) => !isProtectedDiffPath(filePath)))
    : null;
  const aheadDescriptors = ancestryAvailable ? uniqueDescriptors(compareTrace, baseTrace.aliases) : [];
  const behindDescriptors = ancestryAvailable ? uniqueDescriptors(baseTrace, compareTrace.aliases) : [];
  const readObject = options.readObject || createS3ObjectReader(options.s3, options.bucket, new Map());
  const diff = await buildCommitDiff(baseSnapshot, compareSnapshot, {
    readObject,
    maxBytes: options.maxBytes,
  });
  const files = diff.files.map((file) => ({
    ...file,
    ...conflictForFile(file, baseSnapshot, compareSnapshot, mergeSnapshot),
  }));
  const count = (status) => files.filter((file) => file.status === status).length;
  const conflictCount = files.filter((file) => file.conflict).length;

  return {
    repository: { _id: repository._id, name: repository.name },
    base: { name: baseName, head: baseBranch.head || null },
    compare: { name: compareName, head: compareBranch.head || null },
    mergeBase: mergeDescriptor ? String(mergeDescriptor.commit.hash || mergeDescriptor.id) : null,
    ancestryAvailable,
    conflictAnalysisAvailable: Boolean(mergeSnapshot),
    ahead: ancestryAvailable ? aheadDescriptors.length : null,
    behind: ancestryAvailable ? behindDescriptors.length : null,
    commits: aheadDescriptors.map((descriptor) => comparisonCommit(repository, descriptor, defaultBranch)),
    files,
    summary: {
      filesChanged: files.length,
      added: count("added"),
      modified: count("modified"),
      deleted: count("deleted"),
      renamed: count("renamed"),
      additions: files.reduce((total, file) => total + (file.additions || 0), 0),
      deletions: files.reduce((total, file) => total + (file.deletions || 0), 0),
      hasConflicts: conflictCount > 0,
      conflictCount,
    },
    warnings: [...new Set([
      ...(baseSnapshotResult.warnings || []),
      ...(compareSnapshotResult.warnings || []),
      ...(!ancestryAvailable ? ["Commit ancestry unavailable for this legacy history"] : []),
      ...(ancestryAvailable && !mergeDescriptor ? ["No common ancestor was found"] : []),
    ])],
  };
}

module.exports = {
  MAX_ANCESTRY_COMMITS,
  compareRepository,
  findMergeBase,
  traceAncestry,
};
