const fs = require("fs");
const Repository = require("../models/repoModel");


// =====================================
// DELETE FILE
// =====================================

const deleteFile = async (req, res) => {
  try {
    const { id, filename } = req.params;

    const repo = await Repository.findById(id);

    if (!repo) {
      return res.status(404).json({
        message: "Repository not found",
      });
    }

    const file = repo.content.find(
      (f) => f.filename === filename
    );

    if (!file) {
      return res.status(404).json({
        message: "File not found",
      });
    }

    // Delete from disk
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    // Remove from latest files
    repo.content = repo.content.filter(
      (f) => f.filename !== filename
    );

    // Remove from commit history
    repo.commits.forEach((commit) => {
      commit.files = commit.files.filter(
        (f) => f.filename !== filename
      );
    });

    await repo.save();

    res.json({
      success: true,
      message: "File deleted successfully",
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Internal Server Error",
    });
  }
};



// =====================================
// RENAME FILE
// =====================================

const renameFile = async (req, res) => {
  try {

    const { id, filename } = req.params;
    const { newName } = req.body;

    if (!newName) {
      return res.status(400).json({
        message: "New filename is required",
      });
    }

    const repo = await Repository.findById(id);

    if (!repo) {
      return res.status(404).json({
        message: "Repository not found",
      });
    }

    // Check duplicate
    const duplicate = repo.content.find(
      (f) => f.filename === newName
    );

    if (duplicate) {
      return res.status(400).json({
        message: "Filename already exists",
      });
    }

    // Update latest files
    repo.content.forEach((file) => {
      if (file.filename === filename) {
        file.filename = newName;
      }
    });

    // Update commit history
    repo.commits.forEach((commit) => {
      commit.files.forEach((file) => {
        if (file.filename === filename) {
          file.filename = newName;
        }
      });
    });

    await repo.save();

    res.json({
      success: true,
      message: "File renamed successfully",
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Internal Server Error",
    });
  }
};


module.exports = {
  deleteFile,
  renameFile,
};