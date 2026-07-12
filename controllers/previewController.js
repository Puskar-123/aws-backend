const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");

async function previewFile(req, res) {
  try {
    const { id, filename } = req.params;

    const repo = await Repository.findById(id);

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

    res.json({
      filename,
      content: data.Body.toString("utf8"),
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Unable to preview file",
    });
  }
}

module.exports = {
  previewFile,
};