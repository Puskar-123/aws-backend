const fs = require("fs").promises;
const path = require("path");

async function addRepo(repoId, tempFilePath, originalFileName) {
  const repoPath = path.resolve(process.cwd(), ".myGit", repoId);
  const stagingPath = path.join(repoPath, "staging");

  try {
    // Create staging folder if it doesn't exist
    await fs.mkdir(stagingPath, { recursive: true });

    // Copy uploaded file using its ORIGINAL filename
    await fs.copyFile(
      tempFilePath,
      path.join(stagingPath, originalFileName)
    );

    console.log(`${originalFileName} added to staging area!`);
  } catch (err) {
    console.error("Error adding file:", err);
    throw err;
  }
}

module.exports = {
  addRepo,
};
