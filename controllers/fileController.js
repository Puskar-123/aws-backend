const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");

async function getFile(req, res) {
  try {
    const { id, filename } = req.params;

    console.log("Repo ID:", id);
    console.log("Filename:", filename);

    // 👇 Add these logs here
    console.log("Mongo URI:", process.env.MONGODB_URI);

    const allRepos = await Repository.find();

    console.log("Total repos:", allRepos.length);
    console.log(
      "IDs:",
      allRepos.map(r => r._id.toString())
    );

    const repo = await Repository.findById(id);

    console.log("Repository:", repo);

    console.log("Repository:", repo);

    if (!repo) {
      return res.status(404).json({
        error: "Repository not found",
      });
    }

    const file = repo.content.find(
      (f) => f.filename === filename
    );

    if (!file) {
      return res.status(404).json({
        error: "File not found",
      });
    }

    const data = await s3.getObject({
      Bucket: S3_BUCKET,
      Key: file.path,
    }).promise();

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    return res.send(data.Body);

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "Unable to download file",
    });
  }
}

module.exports = {
  getFile,
};