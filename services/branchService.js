const {
  findCommitDescriptor,
  getCommitDescriptors,
  getParentCommitDescriptor,
  normalizeSnapshotFile,
  reconstructSnapshot,
} = require("./snapshotService");

function branchByName(repository, name) {
  return (repository.branches || []).find((branch) => branch.name === name) || null;
}

function normalizeCommit(repository, descriptor) {
  const value = descriptor.commit;
  const author = value.author || {};
  return {
    ...value,
    hash: value.hash || String(value._id || descriptor.id),
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
    summary: value.summary || null,
    time: value.time || null,
  };
}

function getBranchHistory(repository, branchName, defaultBranchName, limit = 1000) {
  const branch = branchByName(repository, branchName);
  if (!branch) return null;
  const descriptors = getCommitDescriptors(repository);

  if (branch.head) {
    const commits = [];
    const visited = new Set();
    let descriptor = findCommitDescriptor(repository, branch.head);
    while (descriptor && !visited.has(descriptor.id) && commits.length < limit) {
      visited.add(descriptor.id);
      const commit = normalizeCommit(repository, descriptor);
      commits.push({ ...commit, branch: commit.branch || defaultBranchName });
      descriptor = getParentCommitDescriptor(repository, descriptor).descriptor;
    }
    return commits;
  }

  return descriptors
    .map((descriptor) => normalizeCommit(repository, descriptor))
    .filter((commit) => commit.branch === branchName
      || (branchName === defaultBranchName && !commit.branch))
    .map((commit) => ({ ...commit, branch: commit.branch || defaultBranchName }))
    .sort((left, right) => new Date(right.time || 0) - new Date(left.time || 0))
    .slice(0, limit);
}

function getBranchSnapshot(repository, branchName) {
  const branch = branchByName(repository, branchName);
  if (!branch) return null;
  const warnings = [];
  const descriptor = branch.head ? findCommitDescriptor(repository, branch.head) : null;
  let files = descriptor
    ? [...reconstructSnapshot(repository, descriptor, { warnings }).values()]
    : [];

  // Headless legacy branches share the repository's last materialized snapshot.
  if (!files.length && !branch.head) {
    files = (repository.content || []).map((file) => normalizeSnapshotFile(repository, file));
  }
  return { branch, descriptor, files, warnings };
}

function getBranchState(repository, branchName, defaultBranchName = repository.defaultBranch || "main") {
  const snapshot = getBranchSnapshot(repository, branchName);
  if (!snapshot) return null;
  const commitCount = (getBranchHistory(repository, branchName, defaultBranchName) || []).length;
  const fileCount = snapshot.files.length;
  return { isEmpty: fileCount === 0 && commitCount === 0, fileCount, commitCount };
}

module.exports = { branchByName, getBranchHistory, getBranchSnapshot, getBranchState, normalizeCommit };
