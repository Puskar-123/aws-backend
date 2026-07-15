const mongoose = require("mongoose");
const { Schema } = mongoose;

const ReleaseAssetSchema = new Schema({
  name: { type: String, required: true, maxlength: 255 },
  size: { type: Number, required: true, min: 0 },
  contentType: { type: String, default: "application/octet-stream", maxlength: 200 },
  storageKey: { type: String, required: true, select: false },
  checksum: { type: String, required: true, maxlength: 128 },
  downloadCount: { type: Number, default: 0, min: 0 },
  uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const ReleaseSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  tag: { type: Schema.Types.ObjectId, ref: "Tag", required: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, default: "", maxlength: 100000 },
  draft: { type: Boolean, default: true, index: true },
  prerelease: { type: Boolean, default: false, index: true },
  latest: { type: Boolean, default: false, index: true },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  assets: { type: [ReleaseAssetSchema], default: [], validate: [(value) => value.length <= 20, "A release may contain at most 20 assets"] },
}, { timestamps: true });

ReleaseSchema.index({ repository: 1, tag: 1 }, { unique: true });
ReleaseSchema.index({ repository: 1, draft: 1, publishedAt: -1, createdAt: -1 });
ReleaseSchema.index({ repository: 1, latest: 1 }, { partialFilterExpression: { latest: true } });

module.exports = mongoose.model("Release", ReleaseSchema);
