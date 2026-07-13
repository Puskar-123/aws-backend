const fs = require("fs").promises;
const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");

async function pullRepo(req, res) {
  const { id } = req.params;

  try {
    // Find repository
    const repo = await Repository.findById(id);

    if (!repo) {
      return res.status(404).json({
        error: "Repository not found",
      });
    }

    // Local .myGit folder
    const repoPath = path.resolve(process.cwd(), ".myGit", id);

    // Get all objects from S3
    const data = await s3
      .listObjectsV2({
        Bucket: S3_BUCKET,
        Prefix: `repos/${id}/commits/`,
      })
      .promise();

    const latestFiles = new Map();

    // Download every object
    for (const object of data.Contents) {
      const key = object.Key;

      const relativeKey = key.replace(`repos/${id}/`, "");
      const destination = path.join(repoPath, relativeKey);

      // Create folder if it doesn't exist
      await fs.mkdir(path.dirname(destination), {
        recursive: true,
      });

      // Download file
      const file = await s3
        .getObject({
          Bucket: S3_BUCKET,
          Key: key,
        })
        .promise();

      // Save locally
      await fs.writeFile(destination, file.Body);

      // Save latest file list (ignore commit.json)
      const filename = path.basename(key);

      if (filename !== "commit.json") {
        latestFiles.set(filename, {
          filename,
          path: key,
        });
      }
    }

    // Update MongoDB repository content
    repo.content = [...latestFiles.values()];

    await repo.save();

    return res.json({
      message: "Pull successful!",
      files: repo.content,
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Pull failed",
    });
  }
}

module.exports = {
  pullRepo,
};
