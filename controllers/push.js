const fs = require("fs").promises;
const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");

async function pushRepo(req, res) {
  const { id } = req.params;

  const repoPath = path.resolve(process.cwd(), ".myGit");
  const commitsPath = path.join(repoPath, "commits");

  try {
    const repo = await Repository.findById(id);

    if (!repo) {
      return res.status(404).json({
        error: "Repository not found",
      });
    }

    const commitDirs = await fs.readdir(commitsPath);

    const latestFiles = new Map();
    const commitHistory = [];

    for (const commitDir of commitDirs) {
      const commitPath = path.join(commitsPath, commitDir);
      const files = await fs.readdir(commitPath);

      const commitFiles = [];

      for (const file of files) {
        const filePath = path.join(commitPath, file);
        const fileContent = await fs.readFile(filePath);

        const key = `commits/${commitDir}/${file}`;

        await s3.upload({
          Bucket: S3_BUCKET,
          Key: key,
          Body: fileContent,
        }).promise();

        const fileData = {
          filename: file,
          path: key,
        };

        commitFiles.push(fileData);

        // Don't show commit.json in repository files
        if (file !== "commit.json") {
          latestFiles.set(file, fileData);
        }
      }

      commitHistory.push({
        message: `Commit ${commitDir}`,
        files: commitFiles,
        time: new Date(),
      });
    }

    // Latest files only
    repo.content = [...latestFiles.values()];

    // Complete commit history
    repo.commits = commitHistory;

    await repo.save();

    return res.json({
      message: "Push successful!",
      files: repo.content,
      commits: repo.commits,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Push failed",
    });
  }
}

module.exports = {
  pushRepo,
};