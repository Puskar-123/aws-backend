const { v4: uuidv4 } = require("uuid");
const { branchByName, getBranchSnapshot } = require("./branchService");
const { normalizeCommit } = require("./branchService");
const { filesEquivalent, isProtectedDiffPath } = require("./diffService");
const { findMergeBase, traceAncestry } = require("./compareService");
const { reconstructSnapshot } = require("./snapshotService");
const { findCommitDescriptor } = require("./snapshotService");

const MAX_STORED_PATCH_BYTES = 50000;
const MAX_STORED_DIFF_BYTES = 500000;

function httpError(status, message, extras = {}) {
  return Object.assign(new Error(message), { status, ...extras });
}

function validPullNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw httpError(400, "Invalid pull request number");
  return number;
}

function cleanText(value, maximum, field, required = false) {
  const text = String(value || "").trim();
  if (required && !text) throw httpError(400, `${field} is required`);
  if (text.length > maximum) throw httpError(400, `${field} must be ${maximum} characters or fewer`);
  return text;
}

function idOf(value) {
  return String(value?._id || value?.id || value || "");
}

function canEditPullRequest(pullRequest, repository, userId) {
  return Boolean(userId) && [idOf(pullRequest.author), idOf(repository.owner)].includes(String(userId));
}

function snapshotMap(result, includeProtected = false) {
  return new Map((result?.files || []).filter((file) => includeProtected || !isProtectedDiffPath(file.path)).map((file) => [file.path, file]));
}

function changedFrom(file, ancestor) {
  if (!file && !ancestor) return false;
  if (!file || !ancestor) return true;
  return !filesEquivalent(file, ancestor);
}

function buildMergedSnapshot(repository, baseName, compareName) {
  const baseBranch = branchByName(repository, baseName);
  const compareBranch = branchByName(repository, compareName);
  if (!baseBranch || !compareBranch) throw httpError(404, "Pull request branch no longer exists");
  const base = snapshotMap(getBranchSnapshot(repository, baseName), true);
  const compare = snapshotMap(getBranchSnapshot(repository, compareName), true);
  const baseTrace = traceAncestry(repository, baseBranch.head);
  const compareTrace = traceAncestry(repository, compareBranch.head);
  const mergeDescriptor = findMergeBase(baseTrace, compareTrace);

  // Legacy histories have no safe three-way ancestor. A conflict-free live
  // comparison permits using the compare snapshot as the merge result.
  if (!mergeDescriptor) return { files: [...compare.values()], legacy: true };

  const ancestor = new Map(reconstructSnapshot(repository, mergeDescriptor));
  const merged = new Map(base);
  const paths = new Set([...ancestor.keys(), ...compare.keys()]);
  for (const filePath of paths) {
    if (isProtectedDiffPath(filePath)) continue;
    const ancestorFile = ancestor.get(filePath) || null;
    const compareFile = compare.get(filePath) || null;
    if (!changedFrom(compareFile, ancestorFile)) continue;
    if (!compareFile) merged.delete(filePath);
    else merged.set(filePath, compareFile);
  }
  return { files: [...merged.values()], legacy: false };
}

function createMergeCommit(repository, pullRequest, comparison, userId) {
  const base = branchByName(repository, pullRequest.baseBranch);
  const compare = branchByName(repository, pullRequest.compareBranch);
  if (!base || !compare) throw httpError(404, "Pull request branch no longer exists");
  const merged = buildMergedSnapshot(repository, pullRequest.baseBranch, pullRequest.compareBranch);
  const hash = uuidv4();
  const time = new Date();
  const snapshot = merged.files.map((file) => ({
    filename: file.filename,
    path: file.path,
    hash: file.hash,
    s3Key: file.s3Key || file.storageKey,
    storageKey: file.storageKey,
  }));
  repository.commits.push({
    hash,
    parent: base.head || null,
    parents: [base.head, compare.head].filter(Boolean),
    branch: pullRequest.baseBranch,
    author: { name: "CodeHub", email: "" },
    message: `Merge pull request #${pullRequest.number} from ${pullRequest.compareBranch}`,
    files: (comparison.files || []).map((file) => ({
      filename: file.path.split("/").at(-1),
      path: file.path,
      oldPath: file.oldPath || undefined,
      status: file.status,
      hash: file.hash,
    })),
    snapshot,
    summary: {
      filesChanged: comparison.summary.filesChanged,
      additions: comparison.summary.additions,
      deletions: comparison.summary.deletions,
    },
    time,
  });
  base.head = hash;
  if (base.isDefault || repository.defaultBranch === base.name) repository.content = snapshot;
  return { hash, time, snapshot, legacy: merged.legacy, mergedBy: userId };
}

function comparisonSnapshot(comparison) {
  let remaining = MAX_STORED_DIFF_BYTES;
  const files = (comparison.files || []).map((file) => {
    const rawPatch = typeof file.patch === "string" ? file.patch : "";
    const byteLimit = Math.max(0, Math.min(MAX_STORED_PATCH_BYTES, remaining));
    let patch = rawPatch.slice(0, byteLimit);
    while (Buffer.byteLength(patch, "utf8") > byteLimit) patch = patch.slice(0, -1);
    remaining -= Buffer.byteLength(patch, "utf8");
    return {
      path: file.path,
      oldPath: file.oldPath || undefined,
      status: file.status,
      additions: file.additions || 0,
      deletions: file.deletions || 0,
      isBinary: Boolean(file.isBinary || file.binary),
      tooLarge: Boolean(file.tooLarge),
      conflict: Boolean(file.conflict),
      conflictReason: file.conflictReason || undefined,
      patch: patch || undefined,
    };
  });
  return {
    baseHead: comparison.base?.head || null,
    compareHead: comparison.compare?.head || null,
    mergeBase: comparison.mergeBase || null,
    commitIds: (comparison.commits || []).map((commit) => commit.hash || commit.id).filter(Boolean).map(String),
    summary: { ...comparison.summary },
    files,
  };
}

function historicalComparison(repository, pullRequest, useFinal = false) {
  const ids = useFinal ? pullRequest.finalCommitIds : pullRequest.commitIds;
  const summary = useFinal ? pullRequest.finalChangedFilesSummary : pullRequest.changedFilesSummary;
  const files = useFinal ? pullRequest.finalChangedFilesSnapshot : pullRequest.changedFilesSnapshot;
  if (!summary) return null;
  const commits = (ids || []).map((id) => findCommitDescriptor(repository, id))
    .filter(Boolean)
    .map((descriptor) => {
      const commit = normalizeCommit(repository, descriptor);
      return {
        id: descriptor.id,
        hash: commit.hash,
        message: commit.message,
        author: commit.author,
        createdAt: commit.time,
        parent: commit.parent,
        branch: commit.branch,
      };
    });
  return {
    repository: { _id: repository._id, name: repository.name },
    base: { name: pullRequest.baseBranch, head: useFinal ? pullRequest.finalBaseHead : pullRequest.baseHeadAtCreation },
    compare: { name: pullRequest.compareBranch, head: useFinal ? pullRequest.finalCompareHead : pullRequest.compareHeadAtCreation },
    mergeBase: useFinal ? pullRequest.finalMergeBase : pullRequest.mergeBaseAtCreation,
    ancestryAvailable: null,
    commits,
    files: (files || []).map((file) => ({ ...(file.toObject ? file.toObject() : file), hunks: [] })),
    summary: summary.toObject ? summary.toObject() : { ...summary },
    isHistorical: true,
  };
}

function legacyMergeComparison(repository, pullRequest) {
  if (!pullRequest.mergeCommit) return null;
  const descriptor = findCommitDescriptor(repository, pullRequest.mergeCommit);
  if (!descriptor || !descriptor.commit.summary) return null;
  const commit = normalizeCommit(repository, descriptor);
  return {
    repository: { _id: repository._id, name: repository.name },
    base: { name: pullRequest.baseBranch, head: pullRequest.mergeCommit },
    compare: { name: pullRequest.compareBranch, head: commit.parents?.[1] || null },
    mergeBase: commit.parent || null,
    ancestryAvailable: null,
    commits: commit.parents?.[1] ? [{ id: commit.parents[1], hash: commit.parents[1], message: "Merged changes", author: commit.author, createdAt: commit.time, branch: pullRequest.compareBranch }] : [],
    files: (commit.files || []).map((file) => ({ ...file, additions: 0, deletions: 0, conflict: false, hunks: [] })),
    summary: commit.summary,
    isHistorical: true,
    historicalDataLimited: true,
  };
}

function reviewSummary(reviews, currentCompareHead) {
  const latest = new Map();
  for (const review of reviews || []) latest.set(idOf(review.reviewer), review);
  const latestByReviewer = [...latest.values()].map((review) => {
    const value = review.toObject ? review.toObject() : { ...review };
    const stale = value.decision === "approved" && Boolean(value.commitHead) && String(value.commitHead) !== String(currentCompareHead || "");
    return { ...value, stale };
  });
  return {
    approved: latestByReviewer.filter((review) => review.decision === "approved" && !review.stale).length,
    changesRequested: latestByReviewer.filter((review) => review.decision === "changes_requested").length,
    commented: latestByReviewer.filter((review) => review.decision === "commented").length,
    blocking: latestByReviewer.some((review) => review.decision === "changes_requested"),
    latestByReviewer,
  };
}

module.exports = {
  buildMergedSnapshot,
  canEditPullRequest,
  cleanText,
  comparisonSnapshot,
  createMergeCommit,
  historicalComparison,
  httpError,
  idOf,
  legacyMergeComparison,
  reviewSummary,
  validPullNumber,
};
