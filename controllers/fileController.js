const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");

async function getFile(req, res) {
  try {
    const { id, filename } = req.params;

    console.log("=================================");
    console.log("Repo ID:", id);
    console.log("Filename:", filename);
    console.log("Mongo URI:", process.env.MONGODB_URI);
    console.log("=================================");

    // Show all repositories
    const allRepos = await Repository.find();

    console.log("Total repos:", allRepos.length);
    console.log(
      "Repo IDs:",
      allRepos.map((r) => r._id.toString())
    );

    // Find repository
    const repo = await Repository.findById(id);

    console.log("Repository:", repo);

    if (!repo) {
      return res.status(404).json({
        error: "Repository not found",
      });
    }

    // Find file
    const file = repo.content.find(
      (f) => f.filename === filename
    );

    console.log("File object:", file);

    if (!file) {
      return res.status(404).json({
        error: "File not found",
      });
    }

    console.log("S3 Bucket:", S3_BUCKET);
    console.log("S3 Key:", file.path);

    try {
      const data = await s3
        .getObject({
          Bucket: S3_BUCKET,
          Key: file.path,
        })
        .promise();

      console.log("S3 download successful!");

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      return res.send(data.Body);

    } catch (err) {
      console.error("========== S3 ERROR ==========");
      console.error(err);
      console.error("==============================");

      return res.status(500).json({
        error: "Unable to download file from S3",
        details: err.message,
      });
    }

  } catch (err) {
    console.error("========== SERVER ERROR ==========");
    console.error(err);
    console.error("==================================");

    return res.status(500).json({
      error: "Internal Server Error",
      details: err.message,
    });
  }
}

module.exports = {
  getFile,
};