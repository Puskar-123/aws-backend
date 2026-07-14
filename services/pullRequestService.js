const { v4: uuidv4 } = require("uuid");
const { branchByName, getBranchSnapshot } = require("./branchService");
const { filesEquivalent, isProtectedDiffPath } = require("./diffService");
const { findMergeBase, traceAncestry } = require("./compareService");
const { reconstructSnapshot } = require("./snapshotService");

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

module.exports = {
  buildMergedSnapshot,
  canEditPullRequest,
  cleanText,
  createMergeCommit,
  httpError,
  idOf,
  validPullNumber,
};
