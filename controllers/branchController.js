const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");

async function listBranches(req, res) {
  try {
    const repo = await getAccessibleRepository(req, req.params.id);
    ensureDefaultBranch(repo);
    return res.json({ branches: repo.branches });
  } catch (error) {
    return sendAccessError(res, error);
  }
}

async function createBranch(req, res) {
  try {
    const repo = await getAccessibleRepository(req, req.params.id, { write: true });
    const name = validateBranchName(req.body?.name);
    ensureDefaultBranch(repo);
    if (repo.branches.some((branch) => branch.name === name)) {
      return res.status(409).json({ error: `Branch '${name}' already exists` });
    }
    const sourceName = req.body?.source || repo.branches.find((branch) => branch.isDefault).name;
    validateBranchName(sourceName);
    const source = repo.branches.find((branch) => branch.name === sourceName);
    if (!source) return res.status(404).json({ error: `Source branch '${sourceName}' does not exist` });
    repo.branches.push({ name, head: source.head || null, isDefault: false });
    await repo.save();
    return res.status(201).json({ branch: repo.branches.find((branch) => branch.name === name) });
  } catch (error) {
    return sendAccessError(res, error);
  }
}

async function deleteBranch(req, res) {
  try {
    const repo = await getAccessibleRepository(req, req.params.id, { write: true });
    const name = validateBranchName(req.params.branchName);
    const branch = repo.branches.find((item) => item.name === name);
    if (!branch) return res.status(404).json({ error: `Branch '${name}' does not exist` });
    if (branch.isDefault) return res.status(400).json({ error: "Cannot delete the default branch" });
    repo.branches = repo.branches.filter((item) => item.name !== name);
    await repo.save();
    return res.json({ message: `Deleted branch ${name}` });
  } catch (error) {
    return sendAccessError(res, error);
  }
}

module.exports = { listBranches, createBranch, deleteBranch };
