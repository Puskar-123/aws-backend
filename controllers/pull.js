const fs = require("fs").promises;
const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");
const { normalizeRepositoryPath } = require("../utils/paths");

async function pullRepo(req, res) {
  const { id } = req.params;
  try {
    const repo = req.repository || await Repository.findById(id);
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    // Materialize only the current MongoDB snapshot. Listing every historical
    // S3 object can select stale versions and must not erase stored hashes.
    const destinationRoot = path.resolve(process.cwd(), ".myGit", id, "pulled");
    for (const file of repo.content) {
      const relativePath = normalizeRepositoryPath(file.path || file.filename);
      const destination = path.resolve(destinationRoot, ...relativePath.split("/"));
      if (!destination.startsWith(`${destinationRoot}${path.sep}`)) {
        return res.status(400).json({ error: `Unsafe repository file path: ${relativePath}` });
      }
      const object = await s3.getObject({
        Bucket: S3_BUCKET,
        Key: file.s3Key || file.path,
      }).promise();
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, object.Body);
    }

    return res.json({ message: "Pull successful!", files: repo.content });
  } catch (err) {
    console.error("Pull failed:", err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : "Pull failed" });
  }
}

module.exports = { pullRepo };
