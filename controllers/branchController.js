const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");
const { getBranchHistory } = require("../services/branchService");
const { safeNotifyRepositoryWatchers } = require("../services/notificationService");
const { assertCanDeleteBranch, getProtectionSummary } = require("../services/branchProtectionService");
const { getAuthenticatedUserId } = require("../utils/repositoryAccess");

function createBranchController({ getRepository = getAccessibleRepository } = {}) {
  async function listBranches(req, res) {
    try {
      const repo = await getRepository(req, req.params.id);
      const defaultBranch = ensureDefaultBranch(repo);
      const branches = repo.branches.map((branch) => ({
        name: branch.name,
        head: branch.head || null,
        isDefault: branch.name === defaultBranch.name,
        createdAt: branch.createdAt || null,
        updatedAt: branch.updatedAt || null,
        commitCount: (getBranchHistory(repo, branch.name, defaultBranch.name) || []).length,
        protection: getProtectionSummary(repo, branch.name, getAuthenticatedUserId(req)),
      }));
      return res.json({ defaultBranch: defaultBranch.name, branches });
    } catch (error) {
      return sendAccessError(res, error);
    }
  }

  async function createBranch(req, res) {
    try {
      const repo = req.repository || await getRepository(req, req.params.id, { write: true });
      const name = validateBranchName(req.body?.name);
      const defaultBranch = ensureDefaultBranch(repo);
      if (repo.branches.some((branch) => branch.name === name)) {
        return res.status(409).json({ error: `Branch '${name}' already exists` });
      }
      const sourceName = validateBranchName(
        req.body?.sourceBranch || req.body?.source || defaultBranch.name
      );
      const source = repo.branches.find((branch) => branch.name === sourceName);
      if (!source) return res.status(404).json({ error: `Source branch '${sourceName}' does not exist` });
      repo.branches.push({ name, head: source.head || null, isDefault: false });
      await repo.save();
      await safeNotifyRepositoryWatchers(repo, {
        actor: req.user?.id,
        type: "branch_created",
        title: `New branch in ${repo.name}`,
        message: `Branch ${name} was created from ${sourceName}`,
        url: `/repo/${repo._id}?branch=${encodeURIComponent(name)}`,
        eventKey: `branch:${repo._id}:${name}`,
        metadata: { branch: name, sourceBranch: sourceName },
      });
      const created = repo.branches.find((branch) => branch.name === name);
      return res.status(201).json({
        message: "Branch created successfully",
        branch: {
          name: created.name,
          head: created.head || null,
          isDefault: false,
          commitCount: (getBranchHistory(repo, name, defaultBranch.name) || []).length,
        },
      });
    } catch (error) {
      return sendAccessError(res, error);
    }
  }

  async function deleteBranch(req, res) {
    try {
      const repo = await getRepository(req, req.params.id, { write: true });
      const defaultBranch = ensureDefaultBranch(repo);
      const name = validateBranchName(req.params.branchName);
      const selectedBranch = req.query?.selectedBranch
        ? validateBranchName(req.query.selectedBranch)
        : null;
      const branch = repo.branches.find((item) => item.name === name);
      if (!branch) return res.status(404).json({ error: "Branch not found" });
      assertCanDeleteBranch(repo, name, req.user?.id || getAuthenticatedUserId(req));
      if (branch.name === defaultBranch.name) {
        return res.status(403).json({ error: "Cannot delete the default branch" });
      }
      if (selectedBranch === name) {
        return res.status(400).json({ error: "Cannot delete the currently selected branch" });
      }
      repo.branches = repo.branches.filter((item) => item.name !== name);
      await repo.save();
      return res.json({ message: `Deleted branch ${name}` });
    } catch (error) {
      return sendAccessError(res, error);
    }
  }

  return { listBranches, createBranch, deleteBranch };
}

module.exports = { createBranchController, ...createBranchController() };
