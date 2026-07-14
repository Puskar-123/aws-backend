const mongoose = require("mongoose");
const { Schema } = mongoose;

const CommentSchema = new Schema({
  author: { type: Schema.Types.ObjectId, ref: "User", required: true },
  body: { type: String, required: true, trim: true, maxlength: 5000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { _id: true });

const PullRequestSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  number: { type: Number, required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: "", maxlength: 10000 },
  author: { type: Schema.Types.ObjectId, ref: "User", required: true },
  baseBranch: { type: String, required: true },
  compareBranch: { type: String, required: true },
  baseHeadAtCreation: { type: String, default: null },
  compareHeadAtCreation: { type: String, default: null },
  status: { type: String, enum: ["open", "closed", "merged"], default: "open", index: true },
  mergeCommit: { type: String, default: null },
  mergedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  mergedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  comments: { type: [CommentSchema], default: [] },
}, { timestamps: true });

PullRequestSchema.index({ repository: 1, number: 1 }, { unique: true });
PullRequestSchema.index({ repository: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("PullRequest", PullRequestSchema);
