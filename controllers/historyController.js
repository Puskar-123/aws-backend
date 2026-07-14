const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");
const { getBranchHistory } = require("../services/branchService");

async function getCommitHistory(req, res) {
  try {
    const repository = await getAccessibleRepository(req, req.params.id, { populateOwner: true });
    const defaultBranch = ensureDefaultBranch(repository).name;
    const branch = validateBranchName(req.params.branchName || req.query.branch || defaultBranch);
    if (!repository.branches.some((item) => item.name === branch)) {
      return res.status(404).json({ error: `Branch '${branch}' does not exist` });
    }
    const rawLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000) {
      return res.status(400).json({ error: "limit must be an integer between 1 and 1000" });
    }
    const commits = getBranchHistory(repository, branch, defaultBranch, rawLimit) || [];
    return res.json({
      success: true,
      repositoryId: repository._id,
      repositoryName: repository.name,
      branch,
      totalCommits: commits.length,
      commits,
    });
  } catch (error) {
    return sendAccessError(res, error);
  }
}

module.exports = { getCommitHistory };
