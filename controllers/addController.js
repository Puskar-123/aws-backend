const fs = require("fs").promises;
const path = require("path");
const { addRepo } = require("./add");
const { assertCanDirectWrite } = require("../services/branchProtectionService");
const { validateBranchName } = require("../utils/branches");

async function addFiles(req, res) {
  try {
    const { id: repoId } = req.params;
    const branch = validateBranchName(req.body?.branch || req.repository.defaultBranch || "main");
    assertCanDirectWrite(req.repository, branch, req.user?.id, "upload");

    // No files uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: "No files uploaded",
      });
    }

    // Stage each uploaded file with its relative project path
    const paths = req.body.paths;

    for (let i = 0; i < req.files.length; i++) {
      const relativePath = Array.isArray(paths)
        ? paths[i]
        : paths;

      await addRepo(
        repoId,
        req.files[i].path,
        req.files[i].originalname,
        relativePath
      );
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

    for (const file of req.files || []) {
      try {
        await fs.unlink(file.path);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") console.error("Unable to delete temp file:", cleanupError);
      }
    }

    res.status(err.status || 500).json({
      error: err.status ? err.message : "Failed to add files",
      ...(err.code ? { code: err.code, branch: err.branch, suggestedAction: err.suggestedAction } : {}),
    });
  }
}

module.exports = {
  addFiles,
};
