const fs = require("fs").promises;
const path = require("path");
const { addRepo } = require("./add");

async function addFiles(req, res) {
  try {
    // No files uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: "No files uploaded",
      });
    }

    // Stage each uploaded file
    for (const file of req.files) {
      await addRepo(file.path, file.originalname);
    }

    // (Optional) Delete temporary uploaded files
    for (const file of req.files) {
      try {
        await fs.unlink(file.path);
      } catch (err) {
        console.error("Unable to delete temp file:", err);
      }
    }

    res.status(200).json({
      message: "Files added to staging area successfully!",
      totalFiles: req.files.length,
    });
  } catch (err) {
    console.error("Error staging files:", err);

    res.status(500).json({
      error: "Failed to add files",
    });
  }
}

module.exports = {
  addFiles,
};