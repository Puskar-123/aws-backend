const Repository = require("../models/repoModel");

async function getCommitHistory(req, res) {
  try {
    const { id } = req.params;

    const repo = await Repository.findById(id);

    if (!repo) {
      return res.status(404).json({
        error: "Repository not found",
      });
    }

    return res.json({
      commits: repo.commits || [],
    });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Failed to fetch commit history",
    });
  }
}

module.exports = {
  getCommitHistory,
};