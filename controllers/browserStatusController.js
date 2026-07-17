const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");
const { hasRepositoryPermission } = require("../services/repositoryPermissionService");
const { listFiles, pendingFor, stagingPath } = require("../utils/browserWorkflow");

async function getBrowserStatus(req, res) {
  try {
    const repository = req.repository;
    const branchName = validateBranchName(req.params.branchName || req.query.branch || ensureDefaultBranch(repository).name);
    const branch = (repository.branches || []).find((item) => item.name === branchName);
    if (!branch) return res.status(404).json({ error: `Branch '${branchName}' does not exist` });

    const userId = req.user?.id || null;
    const pending = userId ? pendingFor(repository, userId, branchName) : [];
    const stagedFiles = userId ? await listFiles(stagingPath(repository._id, userId, branchName)) : [];
    const localHead = pending.at(-1)?.hash || branch.head || null;
    const remoteHead = branch.head || null;
    const pendingBase = pending[0]?.parent || null;
    const remoteChanged = Boolean(pending.length && String(pendingBase || "") !== String(remoteHead || ""));
    return res.json({
      branch: branchName,
      localHead,
      remoteHead,
      aheadCount: pending.length,
      behindCount: remoteChanged ? 1 : 0,
      hasStagedChanges: stagedFiles.length > 0,
      stagedFiles,
      modifiedFiles: [],
      deletedFiles: [],
      hasUnpushedCommits: pending.length > 0,
      hasRemoteChanges: remoteChanged,
      canWrite: Boolean(userId && hasRepositoryPermission(repository, userId, "write_files")),
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load repository status" });
  }
}

module.exports = { getBrowserStatus };
