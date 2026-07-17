const mongoose = require("mongoose");
const { Schema } = mongoose;
const PullRequestTestResultSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  pullRequest: { type: Schema.Types.ObjectId, ref: "PullRequest", required: true, index: true },
  tester: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["passed", "failed"], required: true },
  summary: { type: String, required: true, trim: true, maxlength: 1000 },
}, { timestamps: true });
PullRequestTestResultSchema.index({ repository: 1, pullRequest: 1, createdAt: -1 });
module.exports = mongoose.model("PullRequestTestResult", PullRequestTestResultSchema);
