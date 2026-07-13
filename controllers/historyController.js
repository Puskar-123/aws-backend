const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");

function normalizeCommit(commit, repository, index) {
  const value = commit.toObject ? commit.toObject() : commit;
  const author = value.author || {};
  return {
    ...value,
    hash: value.hash || String(value._id || `legacy-${index + 1}`),
    parent: value.parent || value.parents?.[0] || null,
    parents: value.parents?.length ? value.parents : (value.parent ? [value.parent] : []),
    branch: value.branch || null,
    author: {
      name: author.name || repository.owner?.username || "Unknown",
      email: author.email || repository.owner?.email || "",
    },
    message: value.message || "No message",
    files: value.files || [],
    deletedFiles: value.deletedFiles || [],
    time: value.time || null,
  };
}

async function getCommitHistory(req, res) {
  try {
    const repository = await getAccessibleRepository(req, req.params.id, { populateOwner: true });
    const defaultBranch = ensureDefaultBranch(repository).name;
    const branch = validateBranchName(req.params.branchName || req.query.branch || defaultBranch);
    const branchRef = repository.branches.find((item) => item.name === branch);
    if (!branchRef) return res.status(404).json({ error: `Branch '${branch}' does not exist` });
    const rawLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000) {
      return res.status(400).json({ error: "limit must be an integer between 1 and 1000" });
    }

    const normalized = (repository.commits || []).map((commit, index) =>
      normalizeCommit(commit, repository, index)
    );
    let commits;
    if (branchRef.head) {
      const byHash = new Map(normalized.map((commit) => [commit.hash, commit]));
      commits = [];
      const visited = new Set();
      let hash = branchRef.head;
      while (hash && !visited.has(hash) && commits.length < rawLimit) {
        visited.add(hash);
        const commit = byHash.get(hash);
        if (!commit) break;
        commits.push({ ...commit, branch: commit.branch || defaultBranch });
        hash = commit.parent || commit.parents?.[0];
      }
    } else {
      commits = normalized
        .filter((commit) => commit.branch === branch || (branch === defaultBranch && !commit.branch))
        .map((commit) => ({ ...commit, branch: commit.branch || defaultBranch }))
        .sort((left, right) => new Date(right.time || 0) - new Date(left.time || 0))
        .slice(0, rawLimit);
    }

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
