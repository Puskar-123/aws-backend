const mongoose = require("mongoose");
const { Schema } = mongoose;

const TYPES = [
  "commit", "branch_created", "pull_request_opened", "pull_request_commented",
  "pull_request_reviewed", "pull_request_merged", "issue_opened", "issue_commented",
  "issue_closed", "issue_reopened", "repository_forked", "repository_starred", "mention",
  "repository_invitation", "repository_invitation_accepted", "repository_invitation_declined",
  "collaborator_removed", "collaborator_role_changed",
  "review_requested", "review_comment", "review_reply", "review_submitted",
  "review_conversation_reopened", "review_required_again",
  "release_published",
  "workflow_failed", "workflow_recovered",
  "chat_message", "mentor_request", "mentor_request_accepted", "mentor_request_declined", "chat_report_resolved",
  "contribution_started", "contribution_branch_approval", "contribution_completed",
  "call_invitation", "missed_call",
];

const NotificationSchema = new Schema({
  recipient: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
  repository: { type: Schema.Types.ObjectId, ref: "Repository", default: null, index: true },
  type: { type: String, enum: TYPES, required: true, index: true },
  title: { type: String, required: true, maxlength: 300 },
  message: { type: String, default: "", maxlength: 1000 },
  url: { type: String, required: true },
  read: { type: Boolean, default: false, index: true },
  readAt: { type: Date, default: null },
  metadata: { type: Schema.Types.Mixed, default: {} },
  eventKey: { type: String, default: null },
}, { timestamps: true });

NotificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
NotificationSchema.index({ recipient: 1, createdAt: -1 });
NotificationSchema.index({ eventKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Notification", NotificationSchema);
module.exports.NOTIFICATION_TYPES = TYPES;
