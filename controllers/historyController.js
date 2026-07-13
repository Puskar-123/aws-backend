const mongoose = require("mongoose");
const Repository = require("../models/repoModel");

async function getCommitHistory(req, res) {
  try {
    console.log("==================================");
    console.log("GET COMMIT HISTORY");
    console.log("Request URL:", req.originalUrl);
    console.log("Request Params:", req.params);

    const { id } = req.params;

    // Check if repository ID exists
    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Repository ID is required",
      });
    }

    // Validate MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Repository ID",
      });
    }

    // Find repository
    const repository = await Repository.findById(id);

    if (!repository) {
      return res.status(404).json({
        success: false,
        error: "Repository not found",
      });
    }

    // Return commit history
    return res.status(200).json({
      success: true,
      repositoryId: repository._id,
      repositoryName: repository.name,
      totalCommits: repository.commits
        ? repository.commits.length
        : 0,
      commits: repository.commits || [],
    });

  } catch (error) {
    console.error("History Controller Error:", error);

    return res.status(500).json({
      success: false,
      error: "Internal Server Error",
    });
  }
}

module.exports = {
  getCommitHistory,
};