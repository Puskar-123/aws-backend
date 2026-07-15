const os = require("os");
const mongoose = require("mongoose");
require("dotenv").config();
const { pollOnce } = require("./mockWorker");

const runnerId = `mock-${os.hostname()}-${process.pid}`;
const intervalMs = Math.max(250, Number(process.env.CODEHUB_RUNNER_POLL_MS || 1000));
let stopping = false; let working = false;
async function tick() {
  if (stopping || working) return;
  working = true;
  try { await pollOnce(runnerId); } catch (error) { console.error("Mock runner cycle failed:", error.message); }
  finally { working = false; }
}
async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required by the queue worker");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`CodeHub safe mock runner ${runnerId} connected. Repository commands will NOT execute.`);
  const timer = setInterval(tick, intervalMs); timer.unref(); await tick();
  const stop = async () => { stopping = true; clearInterval(timer); while (working) await new Promise((resolve) => setTimeout(resolve, 25)); await mongoose.disconnect(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { main };
