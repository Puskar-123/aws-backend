const mongoose = require("mongoose");
const { REPOSITORY_ROLES } = require("../constants/repositoryPermissions");
const { Schema } = mongoose;

const RepositoryMemberSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  role: { type: String, enum: Object.values(REPOSITORY_ROLES), required: true },
  status: { type: String, enum: ["active", "expired", "suspended"], default: "active" },
  permissions: { type: [String], default: undefined, select: false },
  allowedBranches: { type: [String], default: [] },
  accessStartsAt: { type: Date, default: null }, accessExpiresAt: { type: Date, default: null, index: true },
  retainViewerAfterExpiry: { type: Boolean, default: false },
  invitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  joinedAt: { type: Date, default: Date.now },
  migrationSource: { type: String, enum: ["legacy_owner", "legacy_maintainer", "legacy_write", "legacy_read"], default: null },
  legacyIndefiniteAccess: { type: Boolean, default: false },
}, { timestamps: true });
RepositoryMemberSchema.index({ repository: 1, user: 1 }, { unique: true });
RepositoryMemberSchema.index({ repository: 1, role: 1, status: 1 });
RepositoryMemberSchema.index({ user: 1, status: 1 });
module.exports = mongoose.model("RepositoryMember", RepositoryMemberSchema);
