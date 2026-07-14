const mongoose = require("mongoose");
const { Schema } = mongoose;

const CommentSchema = new Schema({
  author: { type: Schema.Types.ObjectId, ref: "User", required: true },
  body: { type: String, required: true, trim: true, maxlength: 5000 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { _id: true });

const ReviewSchema = new Schema({
  reviewer: { type: Schema.Types.ObjectId, ref: "User", required: true },
  decision: { type: String, enum: ["approved", "changes_requested", "commented"], required: true },
  body: { type: String, default: "", maxlength: 5000 },
  commitHead: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { _id: true });

const ComparisonSummarySchema = new Schema({
  filesChanged: Number,
  additions: Number,
  deletions: Number,
  added: Number,
  modified: Number,
  deleted: Number,
  renamed: Number,
  hasConflicts: Boolean,
  conflictCount: Number,
}, { _id: false });

const ChangedFileSchema = new Schema({
  path: String,
  oldPath: String,
  status: String,
  additions: Number,
  deletions: Number,
  isBinary: Boolean,
  tooLarge: Boolean,
  conflict: Boolean,
  conflictReason: String,
  patch: { type: String, maxlength: 50000 },
}, { _id: false });

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
  mergeBaseAtCreation: { type: String, default: null },
  commitIds: { type: [String], default: [] },
  changedFilesSummary: { type: ComparisonSummarySchema, default: null },
  changedFilesSnapshot: { type: [ChangedFileSchema], default: [] },
  finalBaseHead: { type: String, default: null },
  finalCompareHead: { type: String, default: null },
  finalMergeBase: { type: String, default: null },
  finalCommitIds: { type: [String], default: [] },
  finalChangedFilesSummary: { type: ComparisonSummarySchema, default: null },
  finalChangedFilesSnapshot: { type: [ChangedFileSchema], default: [] },
  status: { type: String, enum: ["open", "closed", "merged"], default: "open", index: true },
  mergeCommit: { type: String, default: null },
  mergedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  mergedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  comments: { type: [CommentSchema], default: [] },
  reviews: { type: [ReviewSchema], default: [] },
}, { timestamps: true });

PullRequestSchema.index({ repository: 1, number: 1 }, { unique: true });
PullRequestSchema.index({ repository: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("PullRequest", PullRequestSchema);
