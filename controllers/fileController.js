const { s3, S3_BUCKET } = require("../config/aws-config");
const Repository = require("../models/repoModel");

async function getFile(req, res) {
  try {
    const { id, filename } = req.params;

    // Find repository
    const repo = await Repository.findById(id);

    if (!repo) {
      return res.status(404).json({
        error: "Repository not found",
      });
    }

    // Find requested file
    const file = repo.content.find(
      (f) => f.filename === filename
    );

    if (!file) {
      return res.status(404).json({
        error: "File not found",
      });
    }

    // Download file from S3
    const data = await s3
      .getObject({
        Bucket: S3_BUCKET,
        Key: file.path,
      })
      .promise();

    // Force browser download
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );

    // Preserve content type if available
    if (data.ContentType) {
      res.setHeader("Content-Type", data.ContentType);
    } else {
      res.setHeader(
        "Content-Type",
        "application/octet-stream"
      );
    }

    // Send file
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