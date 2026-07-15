const WorkflowDefinition = require("../models/workflowDefinitionModel");
const { findCommitDescriptor, reconstructSnapshot } = require("./snapshotService");
const { parseWorkflow } = require("./workflowParserService");

const WORKFLOW_PATH = /^\.codehub\/workflows\/[^/]+\.ya?ml$/i;
function isWorkflowPath(value) { return WORKFLOW_PATH.test(String(value || "").replaceAll("\\", "/")); }
function bodyBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string" || value instanceof Uint8Array) return Buffer.from(value);
  throw Object.assign(new Error("Workflow source is unavailable"), { status: 502, code: "WORKFLOW_SOURCE_UNAVAILABLE" });
}
async function discoverWorkflows({ repository, commitHash, storage, bucket, WorkflowModel = WorkflowDefinition, disableRemoved = true }) {
  const descriptor = findCommitDescriptor(repository, commitHash);
  if (!descriptor) throw Object.assign(new Error("Canonical workflow commit was not found"), { status: 404, code: "COMMIT_NOT_FOUND" });
  const snapshot = reconstructSnapshot(repository, descriptor);
  const files = [...snapshot.values()].filter((file) => isWorkflowPath(file.path));
  const discovered = [];
  for (const file of files) {
    const path = String(file.path).replaceAll("\\", "/");
    let parsedDefinition = {}; let validationStatus = "valid"; let validationErrors = [];
    try {
      const key = file.s3Key || file.storageKey;
      if (!key) throw new Error("Workflow source object is missing");
      const source = bodyBuffer((await storage.getObject({ Bucket: bucket, Key: key }).promise()).Body).toString("utf8");
      parsedDefinition = parseWorkflow(source, { path });
    } catch (error) { validationStatus = "invalid"; validationErrors = [String(error.message || "Invalid workflow").slice(0, 1000)]; }
    const definition = await WorkflowModel.findOneAndUpdate(
      { repository: repository._id, path },
      { $set: { name: parsedDefinition.name || path.split("/").at(-1), triggers: parsedDefinition.triggers || [], parsedDefinition, sourceCommitHash: String(commitHash), enabled: true, validationStatus, validationErrors } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    discovered.push(definition);
  }
  if (disableRemoved) await WorkflowModel.updateMany({ repository: repository._id, path: { $nin: files.map((file) => file.path) } }, { $set: { enabled: false } });
  return discovered;
}

module.exports = { WORKFLOW_PATH, bodyBuffer, discoverWorkflows, isWorkflowPath };
