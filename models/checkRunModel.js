const mongoose = require("mongoose");
const { Schema } = mongoose;

const CheckRunSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  commitHash: { type: String, required: true, maxlength: 200, index: true },
  pullRequest: { type: Schema.Types.ObjectId, ref: "PullRequest", default: null, index: true },
  workflowRun: { type: Schema.Types.ObjectId, ref: "WorkflowRun", required: true, index: true },
  name: { type: String, required: true, maxlength: 300 },
  status: { type: String, enum: ["queued", "in_progress", "completed"], default: "queued" },
  conclusion: { type: String, enum: ["success", "failure", "cancelled", "timed_out", null], default: null },
  detailsUrl: { type: String, required: true, maxlength: 1000 },
  startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null },
}, { timestamps: true });

CheckRunSchema.index({ repository: 1, commitHash: 1 });
CheckRunSchema.index({ pullRequest: 1, createdAt: -1 });
CheckRunSchema.index({ workflowRun: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("CheckRun", CheckRunSchema);
