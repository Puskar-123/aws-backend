const mongoose = require("mongoose");
const { Schema } = mongoose;
const ACTIONS = ["member_invited", "member_joined", "role_changed", "access_changed",
  "temporary_access_extended", "temporary_access_revoked", "temporary_access_expired",
  "member_suspended", "member_reactivated", "member_removed", "legacy_member_migrated", "owner_duplicate_normalized"];
const RepositoryRoleAuditSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true },
  targetUser: { type: Schema.Types.ObjectId, ref: "User", required: true },
  action: { type: String, enum: ACTIONS, required: true },
  previousRole: String, newRole: String, previousStatus: String, newStatus: String,
  previousAccessStartsAt: Date, newAccessStartsAt: Date,
  previousAccessExpiresAt: Date, newAccessExpiresAt: Date,
  previousAllowedBranches: [String], newAllowedBranches: [String],
  previousRetainViewerAfterExpiry: Boolean, newRetainViewerAfterExpiry: Boolean,
  performedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reason: { type: String, maxlength: 500, default: "" }, metadata: { type: Schema.Types.Mixed, default: undefined },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
RepositoryRoleAuditSchema.index({ repository: 1, createdAt: -1 });
RepositoryRoleAuditSchema.index({ targetUser: 1, createdAt: -1 });
RepositoryRoleAuditSchema.index({ performedBy: 1, createdAt: -1 });
RepositoryRoleAuditSchema.index({ repository: 1, targetUser: 1, action: 1 }, {
  unique: true, partialFilterExpression: { action: "temporary_access_expired" },
});
module.exports = mongoose.model("RepositoryRoleAudit", RepositoryRoleAuditSchema);
module.exports.ACTIONS = ACTIONS;
