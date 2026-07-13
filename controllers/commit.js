const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");

async function commitRepo(repoId, message) {
  if (!mongoose.Types.ObjectId.isValid(repoId)) {
    throw new Error("Invalid repository ID");
  }

  const repo = await Repository.findById(repoId);

  if (!repo) {
    throw new Error("Repository not found");
  }

  const repoPath = path.resolve(process.cwd(), ".myGit", repoId);
  const stagedPath = path.join(repoPath, "staging");
  const commitPath = path.join(repoPath, "commits");

  try {
    const commitID = uuidv4();
    const commitDir = path.join(commitPath, commitID);
    await fs.mkdir(commitDir, { recursive: true });

    const files = await fs.readdir(stagedPath);
    for (const file of files) {
      await fs.copyFile(
        path.join(stagedPath, file),
        path.join(commitDir, file)
      );
    }

    await fs.writeFile(
    path.join(commitDir, "commit.json"),
    JSON.stringify(
      {
        message,
        time: new Date().toISOString(),
      },
      null,
      2
      )
    );

    repo.commits.push({
      message,
      time: new Date(),
    });

    await repo.save();

    console.log(`Commit ${commitID} created with message: ${message}`);
  } catch (err) {
    console.error("Error committing files : ", err);
    throw err;
  }
}

module.exports = { commitRepo };
