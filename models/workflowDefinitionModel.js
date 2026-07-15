const mongoose = require("mongoose");
const { Schema } = mongoose;

const WorkflowDefinitionSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  path: { type: String, required: true, maxlength: 1000 },
  name: { type: String, required: true, maxlength: 200 },
  triggers: [{ type: String, enum: ["push", "pull_request", "workflow_dispatch", "release"] }],
  parsedDefinition: { type: Schema.Types.Mixed, required: true },
  sourceCommitHash: { type: String, required: true, maxlength: 200 },
  enabled: { type: Boolean, default: true, index: true },
  validationStatus: { type: String, enum: ["valid", "invalid"], required: true },
  validationErrors: [{ type: String, maxlength: 1000 }],
}, { timestamps: true });

WorkflowDefinitionSchema.index({ repository: 1, path: 1 }, { unique: true });
WorkflowDefinitionSchema.index({ repository: 1, enabled: 1 });

module.exports = mongoose.model("WorkflowDefinition", WorkflowDefinitionSchema);
