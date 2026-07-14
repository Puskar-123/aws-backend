const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");

dotenv.config();

async function unresolvedCount(pulls, path, match = {}) {
  const stages = [];
  if (path.includes(".")) stages.push({ $unwind: `$${path.split(".")[0]}` });
  stages.push({ $match: match });
  stages.push({ $lookup: { from: "users", localField: path, foreignField: "_id", as: "resolvedUser" } });
  stages.push({ $match: { resolvedUser: { $size: 0 } } }, { $count: "count" });
  return (await pulls.aggregate(stages).toArray())[0]?.count || 0;
}

async function auditPullRequestUserRefs() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const database = client.db();
    const pulls = database.collection("pullrequests");
    const results = {
      database: database.databaseName,
      unresolvedAuthors: await unresolvedCount(pulls, "author"),
      unresolvedCommentAuthors: await unresolvedCount(pulls, "comments.author"),
      unresolvedReviewers: await unresolvedCount(pulls, "reviews.reviewer"),
      unresolvedMergedBy: await unresolvedCount(pulls, "mergedBy", { mergedBy: { $ne: null } }),
    };
    console.log(JSON.stringify(results));
    if (Object.entries(results).some(([key, value]) => key !== "database" && value > 0)) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

auditPullRequestUserRefs().catch((error) => {
  console.error(`PR user-reference audit failed: ${error.message}`);
  process.exitCode = 1;
});
