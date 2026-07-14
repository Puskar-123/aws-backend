const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");

dotenv.config();

async function migrateUsers() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  try {
    const target = client.db().collection("users");
    const source = client.db("githubclone").collection("users");
    if (target.namespace === source.namespace) {
      console.log("User migration skipped: source and target databases are identical");
      return;
    }
    const users = await source.find({}).toArray();
    let copied = 0;
    for (const user of users) {
      const result = await target.updateOne({ _id: user._id }, { $setOnInsert: user }, { upsert: true });
      copied += result.upsertedCount;
    }
    console.log(`User migration complete: ${copied} copied, ${users.length - copied} already present`);
  } finally {
    await client.close();
  }
}

migrateUsers().catch((error) => {
  console.error(`User migration failed: ${error.message}`);
  process.exitCode = 1;
});
