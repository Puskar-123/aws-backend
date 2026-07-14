const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");
const { getBranchSnapshot } = require("../services/branchService");
const { isDefaultIgnoredRepoPath, normalizeRepositoryPath } = require("../utils/paths");

function getSnapshotDescriptor(repository, requestedBranch) {
  const defaultBranch = ensureDefaultBranch(repository);
  const branchName = validateBranchName(requestedBranch || defaultBranch.name);
  const snapshot = getBranchSnapshot(repository, branchName);
  if (!snapshot) {
    const error = new Error(`Branch '${branchName}' does not exist`);
    error.status = 404;
    throw error;
  }
  return { defaultBranch, ...snapshot };
}

async function getSnapshot(req, res) {
  try {
    const repository = await getAccessibleRepository(req, req.params.id, { populateOwner: true });
    const snapshot = getSnapshotDescriptor(repository, req.params.branchName || req.query.branch);
    const files = snapshot.files
      .filter((file) => !isDefaultIgnoredRepoPath(file.path || file.filename))
      .map((file) => ({
        filename: file.filename,
        path: file.path,
        hash: file.hash,
        size: file.size,
        contentType: file.contentType,
      }));
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
      commit: snapshot.descriptor?.commit || null,
      files,
      ...(snapshot.warnings.length ? { warnings: snapshot.warnings } : {}),
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
    const file = snapshot.files.find((item) => item.path === filePath);
    if (!file) return res.status(404).json({ error: "File not found in branch snapshot" });
    const data = await s3.getObject({ Bucket: S3_BUCKET, Key: file.s3Key || file.storageKey || file.path }).promise();
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(filePath).replaceAll('"', "")}"`);
    return res.send(data.Body);
  } catch (error) {
    if (error.code === "NoSuchKey") return res.status(404).json({ error: "File content not found" });
    return sendAccessError(res, error);
  }
}

module.exports = { getSnapshot, getSnapshotFile, getSnapshotDescriptor };
