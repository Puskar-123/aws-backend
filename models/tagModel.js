const mongoose = require("mongoose");
const { Schema } = mongoose;

const TagSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  normalizedName: { type: String, required: true, trim: true, maxlength: 100 },
  targetCommitHash: { type: String, required: true, maxlength: 200 },
  message: { type: String, default: "", maxlength: 2000 },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

TagSchema.index({ repository: 1, normalizedName: 1 }, { unique: true });
TagSchema.index({ repository: 1, createdAt: -1 });

module.exports = mongoose.model("Tag", TagSchema);
