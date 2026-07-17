const fs = require("fs").promises;
const path = require("path");
const { normalizeRepositoryPath } = require("./paths");

const safeSegment = (value) => encodeURIComponent(String(value || "")).replaceAll("%", "_");

function repositoryRoot(repositoryId) {
  return path.resolve(process.cwd(), ".myGit", String(repositoryId));
}

function stagingPath(repositoryId, userId, branch) {
  return path.join(repositoryRoot(repositoryId), "browser-staging", safeSegment(userId), safeSegment(branch));
}

function commitsPath(repositoryId) {
  return path.join(repositoryRoot(repositoryId), "commits");
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(normalizeRepositoryPath(path.relative(root, absolute).split(path.sep).join("/")));
    }
  }
  await visit(root);
  return result.sort();
}

function pendingFor(repository, userId, branch) {
  return (repository.pendingCommits || []).filter((commit) =>
    !commit.pushedAt
    && String(commit.author?.user || "") === String(userId || "")
    && commit.branch === branch
  ).sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
}

module.exports = { commitsPath, listFiles, pendingFor, repositoryRoot, stagingPath };
