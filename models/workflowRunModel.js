const mongoose = require("mongoose");
const { Schema } = mongoose;

const STATUSES = ["queued", "running", "success", "failure", "cancelled", "timed_out"];
const StepSchema = new Schema({
  name: { type: String, required: true, maxlength: 200 },
  command: { type: String, required: true, maxlength: 4000 },
  workingDirectory: { type: String, default: "", maxlength: 1000 },
  status: { type: String, enum: STATUSES, default: "queued" },
  exitCode: { type: Number, default: null },
  startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null }, durationMs: { type: Number, default: null },
  logKey: { type: String, default: null, select: false },
  logPreview: { type: String, default: "", maxlength: 20000 },
}, { _id: true });
const JobSchema = new Schema({
  key: { type: String, required: true, maxlength: 100 }, name: { type: String, required: true, maxlength: 200 },
  runner: { type: String, required: true, maxlength: 100 }, timeoutMinutes: { type: Number, required: true, min: 1, max: 30 },
  status: { type: String, enum: STATUSES, default: "queued" },
  startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null }, durationMs: { type: Number, default: null },
  steps: { type: [StepSchema], default: [] },
}, { _id: true });

const WorkflowRunSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  workflow: { type: Schema.Types.ObjectId, ref: "WorkflowDefinition", required: true },
  workflowPath: { type: String, required: true, maxlength: 1000 }, workflowName: { type: String, required: true, maxlength: 200 },
  workflowType: { type: String, enum: ["standard", "test", "deployment"], default: "standard", index: true },
  definitionSnapshot: { type: Schema.Types.Mixed, required: true, select: false },
  trigger: { type: String, enum: ["push", "pull_request", "workflow_dispatch", "release"], required: true },
  status: { type: String, enum: STATUSES, default: "queued", index: true },
  branch: { type: String, required: true, maxlength: 250 }, commitHash: { type: String, required: true, maxlength: 200, index: true },
  commitMessage: { type: String, default: "", maxlength: 500 },
  pullRequest: { type: Schema.Types.ObjectId, ref: "PullRequest", default: null, index: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
  attempt: { type: Number, default: 1, min: 1 }, previousRun: { type: Schema.Types.ObjectId, ref: "WorkflowRun", default: null },
  queuedAt: { type: Date, default: Date.now }, startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null }, durationMs: { type: Number, default: null },
  cancellationRequested: { type: Boolean, default: false }, runnerId: { type: String, default: null, maxlength: 200 },
  eventKey: { type: String, required: true }, infrastructureAttempts: { type: Number, default: 0, min: 0 },
  jobs: { type: [JobSchema], default: [] },
}, { timestamps: true });

WorkflowRunSchema.index({ repository: 1, createdAt: -1 });
WorkflowRunSchema.index({ repository: 1, branch: 1, createdAt: -1 });
WorkflowRunSchema.index({ pullRequest: 1, createdAt: -1 });
WorkflowRunSchema.index({ eventKey: 1 }, { unique: true });
WorkflowRunSchema.index({ status: 1, queuedAt: 1 });

module.exports = mongoose.model("WorkflowRun", WorkflowRunSchema);
module.exports.WORKFLOW_RUN_STATUSES = STATUSES;
