const Repository = require("../models/repoModel");
const { isSensitiveRepoPath } = require("../utils/repoPath");

const ids = (value) => (Array.isArray(value) ? value : []).map(String);
const cleanFiles = (files = []) => files.filter((file) => {
  try { return !isSensitiveRepoPath(file.path || file.filename || ""); } catch { return false; }
}).map((file) => ({ ...(file.toObject ? file.toObject() : file), _id: undefined }));
const cloneCommits = (commits = []) => commits.map((entry) => {
  const commit = entry.toObject ? entry.toObject() : entry;
  return { ...commit, _id: undefined, files: cleanFiles(commit.files), snapshot: cleanFiles(commit.snapshot) };
});
const social = async (repo, userId, RepoModel = Repository) => ({
  starCount: (repo.stars || []).length,
  watcherCount: (repo.watchers || []).length,
  forkCount: (repo.forks || []).length,
  starredByCurrentUser: Boolean(userId && ids(repo.stars).includes(String(userId))),
  watchedByCurrentUser: Boolean(userId && ids(repo.watchers).includes(String(userId))),
  forkedByCurrentUser: Boolean(userId && await RepoModel.exists({ owner: userId, forkedFrom: repo._id })),
});

function createRepositorySocialController({ RepoModel = Repository } = {}) {
  const toggle = (field, activeKey, countKey, add) => async (req, res) => {
    try {
      const updated = await RepoModel.findByIdAndUpdate(req.repository._id, add ? { $addToSet: { [field]: req.user.id } } : { $pull: { [field]: req.user.id } }, { new: true, projection: { [field]: 1 } });
      return res.json({ [activeKey]: add, [countKey]: (updated?.[field] || []).length });
    } catch { return res.status(500).json({ error: `Unable to ${add ? "add" : "remove"} ${field}` }); }
  };
  const status = async (req, res) => res.json({ social: await social(req.repository, req.user?.id, RepoModel) });
  const fork = async (req, res) => {
    try {
      const source = req.repository; const userId = req.user.id;
      if (await RepoModel.findOne({ owner: userId, forkedFrom: source._id })) return res.status(409).json({ error: "You already forked this repository." });
      let name = source.name; let suffix = 0;
      while (await RepoModel.exists({ name })) { suffix += 1; name = `${source.name}-fork${suffix > 1 ? `-${suffix}` : ""}`; }
      const forked = await RepoModel.create({ name, owner: userId, description: source.description || "", visibility: source.visibility, content: cleanFiles(source.content), commits: cloneCommits(source.commits), branches: (source.branches || []).map((b) => ({ ...(b.toObject ? b.toObject() : b), _id: undefined })), defaultBranch: source.defaultBranch || "main", forkedFrom: source._id, forkedBy: userId, forkDepth: Number(source.forkDepth || 0) + 1 });
      await RepoModel.findByIdAndUpdate(source._id, { $addToSet: { forks: forked._id } });
      if (forked.populate) await forked.populate("owner", "_id username");
      const forkOwner = forked.owner && typeof forked.owner === "object"
        ? { _id: forked.owner._id, username: forked.owner.username || "" }
        : { _id: userId, username: "" };
      return res.status(201).json({ message: "Repository forked successfully", repository: { _id: forked._id, name: forked.name, owner: forkOwner, forkedFrom: { _id: source._id, name: source.name } } });
    } catch (error) { if (error?.code === 11000) return res.status(409).json({ error: "You already forked this repository." }); return res.status(500).json({ error: "Unable to fork repository" }); }
  };
  return { star: toggle("stars", "starred", "starCount", true), unstar: toggle("stars", "starred", "starCount", false), watch: toggle("watchers", "watched", "watcherCount", true), unwatch: toggle("watchers", "watched", "watcherCount", false), status, fork };
}
module.exports = { createRepositorySocialController, social, ...createRepositorySocialController() };
