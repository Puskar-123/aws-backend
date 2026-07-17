const mongoose = require("mongoose"); const { Schema } = mongoose;
const RepositoryHealthSnapshotSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  range: { type: String, enum: ["30d", "90d", "180d"], required: true }, version: { type: Number, required: true },
  score: { type: Number, required: true, min: 0, max: 100 }, status: { type: String, required: true },
  insufficientData: { type: Boolean, default: false }, categories: { type: Schema.Types.Mixed, required: true },
  recommendations: [{ type: String, maxlength: 500 }], calculatedAt: { type: Date, required: true }, snapshotDate: { type: String, required: true },
}, { timestamps: true });
RepositoryHealthSnapshotSchema.index({ repository: 1, range: 1, version: 1, snapshotDate: 1 }, { unique: true });
RepositoryHealthSnapshotSchema.index({ repository: 1, range: 1, calculatedAt: -1 });
module.exports = mongoose.model("RepositoryHealthSnapshot", RepositoryHealthSnapshotSchema);
