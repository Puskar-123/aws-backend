const fs = require("fs").promises;
const path = require("path");
const { s3, S3_BUCKET } = require("../config/aws-config");

async function pullRepo(req, res) {
  try {

    const repoPath = path.resolve(process.cwd(), ".myGit");

    const data = await s3.listObjectsV2({
      Bucket: S3_BUCKET,
      Prefix: "commits/",
    }).promise();

    for (const object of data.Contents) {

      const key = object.Key;

      const destination = path.join(repoPath, key);

      await fs.mkdir(path.dirname(destination), {
        recursive: true,
      });

      const file = await s3.getObject({
        Bucket: S3_BUCKET,
        Key: key,
      }).promise();

      await fs.writeFile(destination, file.Body);
    }

    return res.json({
      message: "Pull successful!",
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