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
      return res.status(404).json({ error: "Repo not found" });
    }

    const commitDirs = await fs.readdir(commitsPath);

    let allFiles = [];
    let commitHistory = [];

    // 🔥 LOOP THROUGH EACH COMMIT FOLDER
    for (const commitDir of commitDirs) {
      const commitPath = path.join(commitsPath, commitDir);
      const files = await fs.readdir(commitPath);

      let commitFiles = [];

      for (const file of files) {
        const filePath = path.join(commitPath, file);
        const fileContent = await fs.readFile(filePath);

        const key = `commits/${commitDir}/${file}`;

        // ✅ UPLOAD TO S3
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
        allFiles.push(fileData);
      }

      // 🔥 CREATE COMMIT OBJECT (PER FOLDER)
      commitHistory.push({
        message: `Commit ${commitDir}`,
        files: commitFiles,
        time: new Date(),
      });
    }

    // ✅ SAVE LATEST FILES
    repo.content = allFiles;

    // 🔥 SAVE COMMITS HISTORY
    if (!repo.commits) {
      repo.commits = [];
    }

    repo.commits.push(...commitHistory);

    await repo.save();

    res.json({
      message: "Push successful!",
      files: allFiles,
      commits: commitHistory,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Push failed" });
  }
}

module.exports = { pushRepo };

