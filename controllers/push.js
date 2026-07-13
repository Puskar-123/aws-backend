const fs = require("fs").promises;
const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");

async function getAllFiles(dir) {
  const entries = await fs.readdir(dir, {
    withFileTypes: true,
  });

  let files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await getAllFiles(full));
    } else {
      files.push(full);
    }
  }

  return files;
}

async function pushRepo(req, res) {
  const { id } = req.params;

  const repoPath = path.resolve(process.cwd(), ".myGit", id);
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
      const files = await getAllFiles(commitPath);

      let commitMessage = "";
      let commitTime = new Date();

      const commitFiles = [];

      for (const file of files) {
        const relativePath = path
          .relative(commitPath, file)
          .split(path.sep)
          .join("/");
        const filename = path.basename(file);

        const fileContent = await fs.readFile(file);

        const key = `repos/${id}/commits/${commitDir}/${relativePath}`;

        // Upload every file to S3
        await s3.upload({
          Bucket: S3_BUCKET,
          Key: key,
          Body: fileContent,
        }).promise();

        // Read commit.json
        if (filename === "commit.json") {

          try {

            const commitInfo = JSON.parse(
              fileContent.toString()
            );

            commitMessage = commitInfo.message || "No Message";
            commitTime = commitInfo.time || new Date();

          } catch (err) {

            console.error("Invalid commit.json", err);

            commitMessage = "Unknown Commit";
            commitTime = new Date();

          }

          // Do NOT show commit.json
          continue;
        }

        const fileData = {
          filename,
          path: relativePath,
          s3Key: key,
        };

        commitFiles.push(fileData);

        // Latest version of every file
        latestFiles.set(relativePath, fileData);
      }

      commitHistory.push({
        message: commitMessage,
        files: commitFiles,
        time: commitTime,
      });
    }

    // Latest repository files
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
