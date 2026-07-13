const fs = require("fs").promises;
const path = require("path");

async function addRepo(
  repoId,
  tempFilePath,
  originalFileName,
  relativePath
) {
  const repoPath = path.resolve(
    process.cwd(),
    ".myGit",
    repoId
  );

  const stagingPath = path.join(
    repoPath,
    "staging"
  );

  try {
    const finalPath =
      relativePath || originalFileName;

    const destination = path.join(
      stagingPath,
      finalPath
    );

    await fs.mkdir(
      path.dirname(destination),
      {
        recursive: true
      }
    );

    await fs.copyFile(
      tempFilePath,
      destination
    );

    console.log(
      finalPath,
      "added successfully."
    );
  } catch (err) {
    console.error(err);

    throw err;
  }
}

module.exports = {
  addRepo
};
