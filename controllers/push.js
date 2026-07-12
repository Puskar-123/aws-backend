const latestFiles = new Map();
const commitHistory = [];

for (const commitDir of commitDirs) {

    const commitPath = path.join(commitsPath, commitDir);
    const files = await fs.readdir(commitPath);

    let commitFiles = [];

    for (const file of files) {

        const filePath = path.join(commitPath, file);
        const fileContent = await fs.readFile(filePath);

        const key = `commits/${commitDir}/${file}`;

        await s3.upload({
            Bucket: S3_BUCKET,
            Key: key,
            Body: fileContent,
        }).promise();

        const fileData = {
            filename: file,
            path: key,
        };

        commitFiles.push(fileData);

        if (file !== "commit.json") {
            latestFiles.set(file, fileData);
        }
    }

    commitHistory.push({
        message: `Commit ${commitDir}`,
        files: commitFiles,
        time: new Date(),
    });
}

repo.content = [...latestFiles.values()];
repo.commits = commitHistory;

await repo.save();

res.json({
    message: "Push successful!",
    files: repo.content,
    commits: repo.commits,
});