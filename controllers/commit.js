const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");

async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);

  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });

    const items = await fs.readdir(src);

    for (const item of items) {
      await copyRecursive(
        path.join(src, item),
        path.join(dest, item)
      );
    }
  } else {
    await fs.copyFile(src, dest);
  }
}

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

    await copyRecursive(stagedPath, commitDir);

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
