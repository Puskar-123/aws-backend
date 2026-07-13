const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");
const { isDefaultIgnoredRepoPath, normalizeRepositoryPath } = require("../utils/paths");

function findCommit(repository, hash) {
  return repository.commits.find((commit) => commit.hash === hash || String(commit._id) === hash);
}

function workingPath(repository, file) {
  const storedPath = String(file.path || file.filename || "").replaceAll("\\", "/");
  const legacyPrefix = `${repository._id}/`;
  return !file.s3Key && storedPath.startsWith(legacyPrefix)
    ? storedPath.slice(legacyPrefix.length)
    : storedPath;
}

function getCommitFiles(repository, head) {
  const visited = new Set();
  let hash = head;
  while (hash && !visited.has(hash)) {
    visited.add(hash);
    const commit = findCommit(repository, hash);
    if (!commit) break;
    const files = (commit.snapshot?.length ? commit.snapshot : commit.files || [])
      .filter((file) => (file.s3Key || file.storageKey) && file.status !== "deleted");
    if (files.length) return { commit, files };
    hash = commit.parent || commit.parents?.[0];
  }
  return { commit: null, files: [] };
}

function getSnapshotDescriptor(repository, requestedBranch) {
  const defaultBranch = ensureDefaultBranch(repository);
  const branchName = validateBranchName(requestedBranch || defaultBranch.name);
  const branch = repository.branches.find((item) => item.name === branchName);
  if (!branch) {
    const error = new Error(`Branch '${branchName}' does not exist`);
    error.status = 404;
    throw error;
  }

  const resolved = getCommitFiles(repository, branch.head);
  const files = resolved.files.length || branchName !== defaultBranch.name
    ? resolved.files
    : repository.content;
  return { defaultBranch, branch, commit: resolved.commit, files };
}

async function getSnapshot(req, res) {
  try {
    const repository = await getAccessibleRepository(req, req.params.id, { populateOwner: true });
    const snapshot = getSnapshotDescriptor(repository, req.params.branchName || req.query.branch);
    return res.json({
      repository: {
        id: repository._id,
        name: repository.name,
        description: repository.description,
        visibility: repository.visibility,
      },
      defaultBranch: snapshot.defaultBranch.name,
      branch: snapshot.branch.name,
      head: snapshot.branch.head || null,
      commit: snapshot.commit || null,
      files: snapshot.files.filter((file) => !isDefaultIgnoredRepoPath(workingPath(repository, file))).map((file) => ({
        filename: file.filename,
        path: workingPath(repository, file),
        hash: file.hash,
        status: file.status,
      })),
    });
  } catch (error) {
    return sendAccessError(res, error);
  }
}

async function getSnapshotFile(req, res) {
  try {
    const repository = await getAccessibleRepository(req, req.params.id);
    const snapshot = getSnapshotDescriptor(repository, req.query.branch);
    const filePath = normalizeRepositoryPath(req.query.path);
    if (isDefaultIgnoredRepoPath(filePath)) {
      return res.status(403).json({ error: "Ignored and protected files are excluded from repository snapshots" });
    }
    const file = snapshot.files.find((item) => workingPath(repository, item) === filePath);
    if (!file) return res.status(404).json({ error: "File not found in branch snapshot" });
    const data = await s3.getObject({ Bucket: S3_BUCKET, Key: file.s3Key || file.path }).promise();
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath).replaceAll('"', "")}"`);
    return res.send(data.Body);
  } catch (error) {
    if (error.code === "NoSuchKey") return res.status(404).json({ error: "File content not found" });
    return sendAccessError(res, error);
  }
}

module.exports = { getSnapshot, getSnapshotFile, getSnapshotDescriptor };
