const mongoose = require("mongoose");
const { Schema } = mongoose;

const COLLABORATOR_ROLES = ["maintainer", "write", "read"];
const REPOSITORY_ROLES = ["maintainer", "viewer", "issue_manager", "tester", "reviewer", "temporary_contributor", "deployment_manager"];
const INVITATION_STATUSES = ["pending", "accepted", "declined", "cancelled", "expired"];

const RepositoryInvitationSchema = new Schema({
  repository: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
  invitedUser: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: COLLABORATOR_ROLES, required: true },
  repositoryRole: { type: String, enum: REPOSITORY_ROLES, default: null },
  allowedBranches: { type: [String], default: [] },
  accessStartsAt: { type: Date, default: null }, accessExpiresAt: { type: Date, default: null },
  retainViewerAfterExpiry: { type: Boolean, default: false },
  status: { type: String, enum: INVITATION_STATUSES, default: "pending", index: true },
  message: { type: String, default: "", maxlength: 300 },
  expiresAt: { type: Date, required: true },
  respondedAt: { type: Date, default: null },
}, { timestamps: true });

RepositoryInvitationSchema.index(
  { repository: 1, invitedUser: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } },
);
RepositoryInvitationSchema.index({ invitedUser: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("RepositoryInvitation", RepositoryInvitationSchema);
module.exports.COLLABORATOR_ROLES = COLLABORATOR_ROLES;
module.exports.REPOSITORY_ROLES = REPOSITORY_ROLES;
module.exports.INVITATION_STATUSES = INVITATION_STATUSES;
