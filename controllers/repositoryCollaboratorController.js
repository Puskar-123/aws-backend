const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const Invitation = require("../models/repositoryInvitationModel");
const User = require("../models/userModel");
const { createNotification } = require("../services/notificationService");
const { getRepositoryRole, hasRepositoryPermission } = require("../services/repositoryPermissionService");

const ROLES = new Set(["maintainer", "write", "read"]);
const idOf = (value) => String(value?._id || value?.id || value || "");
const validId = (value) => mongoose.Types.ObjectId.isValid(value);

function safeUser(user) {
  if (!user) return null;
  return { _id: user._id, username: user.username || "", name: user.name || "", avatarUrl: user.avatarUrl || "" };
}

function safeRepository(repository) {
  if (!repository) return null;
  return { _id: repository._id, name: repository.name, visibility: repository.visibility, owner: safeUser(repository.owner) };
}

function safeInvitation(invitation) {
  const value = invitation?.toObject ? invitation.toObject() : invitation;
  return {
    _id: value._id,
    repository: safeRepository(value.repository),
    invitedUser: safeUser(value.invitedUser),
    invitedBy: safeUser(value.invitedBy),
    role: value.role,
    status: value.status,
    message: value.message || "",
    expiresAt: value.expiresAt,
    respondedAt: value.respondedAt || null,
    createdAt: value.createdAt,
  };
}

const populateInvitation = (query) => query
  .populate("repository", "_id name visibility owner")
  .populate({ path: "repository", populate: { path: "owner", select: "_id username name avatarUrl" } })
  .populate("invitedUser", "_id username name avatarUrl")
  .populate("invitedBy", "_id username name avatarUrl");

function validateRole(role) {
  const normalized = String(role || "").toLowerCase();
  if (!ROLES.has(normalized)) {
    const error = new Error("Role must be maintainer, write, or read");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function sendError(res, error) {
  if (error?.code === 11000) return res.status(409).json({ error: "A pending invitation already exists" });
  return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to manage collaborators" });
}

async function invite(req, res) {
  try {
    const repository = req.repository;
    const username = String(req.body?.username || "").trim();
    const role = validateRole(req.body?.role);
    const message = String(req.body?.message || "").trim();
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?$/.test(username)) {
      return res.status(400).json({ error: "Enter a valid username" });
    }
    if (message.length > 300) return res.status(400).json({ error: "Invitation message must be 300 characters or fewer" });
    const invitedUser = await User.findOne({ username: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") })
      .select("_id username name avatarUrl");
    if (!invitedUser) return res.status(404).json({ error: "User not found" });
    const ownerId = idOf(repository.owner);
    const invitedId = idOf(invitedUser);
    if (invitedId === ownerId) return res.status(400).json({ error: "The repository owner cannot be invited" });
    if (invitedId === String(req.user.id)) return res.status(400).json({ error: "You cannot invite yourself" });
    if ((repository.collaborators || []).some((item) => idOf(item.user) === invitedId)) {
      return res.status(409).json({ error: "This user is already a collaborator" });
    }
    await Invitation.updateMany(
      { repository: repository._id, invitedUser: invitedUser._id, status: "pending", expiresAt: { $lte: new Date() } },
      { $set: { status: "expired", respondedAt: new Date() } },
    );
    const invitation = await Invitation.create({
      repository: repository._id,
      invitedUser: invitedUser._id,
      invitedBy: req.user.id,
      role,
      message,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const populated = await populateInvitation(Invitation.findById(invitation._id));
    await createNotification({
      recipient: invitedUser._id, actor: req.user.id, repository: repository._id,
      type: "repository_invitation", title: "Repository invitation",
      message: `You were invited to collaborate on ${repository.name} as ${role}.`,
      url: "/invitations", eventKey: `repository-invitation:${invitation._id}`,
    });
    return res.status(201).json({ message: "Invitation sent", invitation: safeInvitation(populated) });
  } catch (error) { return sendError(res, error); }
}

async function listCollaborators(req, res) {
  try {
    const repository = await Repository.findById(req.repository._id)
      .populate("owner", "_id username name avatarUrl")
      .populate("collaborators.user", "_id username name avatarUrl");
    const canManage = hasRepositoryPermission(repository, req.user.id, "manage_collaborators");
    const collaborators = canManage
      ? repository.collaborators
      : repository.collaborators.filter((item) => idOf(item.user) === String(req.user.id));
    return res.json({
      owner: safeUser(repository.owner),
      currentUserRole: getRepositoryRole(repository, req.user.id),
      canManage,
      collaborators: collaborators.map((item) => ({
        user: safeUser(item.user), role: item.role, addedBy: idOf(item.addedBy), addedAt: item.addedAt,
      })),
    });
  } catch (error) { return sendError(res, error); }
}

async function listRepositoryInvitations(req, res) {
  try {
    const invitations = await populateInvitation(Invitation.find({ repository: req.repository._id, status: "pending" }).sort({ createdAt: -1 }));
    return res.json({ invitations: invitations.map(safeInvitation) });
  } catch (error) { return sendError(res, error); }
}

async function listReceived(req, res) {
  try {
    await Invitation.updateMany({ invitedUser: req.user.id, status: "pending", expiresAt: { $lte: new Date() } }, { $set: { status: "expired", respondedAt: new Date() } });
    const invitations = await populateInvitation(Invitation.find({ invitedUser: req.user.id, status: "pending" }).sort({ createdAt: -1 }));
    return res.json({ invitations: invitations.map(safeInvitation) });
  } catch (error) { return sendError(res, error); }
}

async function respond(req, res, nextStatus) {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ error: "Invalid invitation ID" });
    const current = await Invitation.findById(req.params.id);
    if (!current) return res.status(404).json({ error: "Invitation not found" });
    if (idOf(current.invitedUser) !== String(req.user.id)) return res.status(403).json({ error: "This invitation belongs to another user" });
    if (current.status !== "pending") return res.status(409).json({ error: `Invitation is already ${current.status}` });
    if (new Date(current.expiresAt) <= new Date()) {
      await Invitation.updateOne({ _id: current._id, status: "pending" }, { $set: { status: "expired", respondedAt: new Date() } });
      return res.status(410).json({ error: "This invitation has expired" });
    }
    const repository = await Repository.findById(current.repository);
    if (!repository) {
      await Invitation.updateOne({ _id: current._id, status: "pending" }, { $set: { status: "cancelled", respondedAt: new Date() } });
      return res.status(404).json({ error: "Repository no longer exists" });
    }
    const invitation = await Invitation.findOneAndUpdate(
      { _id: current._id, invitedUser: req.user.id, status: "pending", expiresAt: { $gt: new Date() } },
      { $set: { status: nextStatus, respondedAt: new Date() } },
      { new: true },
    );
    if (!invitation) return res.status(409).json({ error: "Invitation is no longer pending" });
    if (nextStatus === "accepted") {
      await Repository.updateOne(
        { _id: repository._id, owner: { $ne: req.user.id }, "collaborators.user": { $ne: req.user.id } },
        { $push: { collaborators: { user: req.user.id, role: invitation.role, addedBy: invitation.invitedBy, addedAt: new Date() } } },
      );
    }
    await createNotification({
      recipient: invitation.invitedBy, actor: req.user.id, repository: repository._id,
      type: nextStatus === "accepted" ? "repository_invitation_accepted" : "repository_invitation_declined",
      title: `Invitation ${nextStatus}`,
      message: `Your invitation to collaborate on ${repository.name} was ${nextStatus}.`,
      url: `/repo/${repository._id}/settings/collaborators`,
      eventKey: `repository-invitation-${nextStatus}:${invitation._id}`,
    });
    const populated = await populateInvitation(Invitation.findById(invitation._id));
    return res.json({ message: `Invitation ${nextStatus}`, invitation: safeInvitation(populated) });
  } catch (error) { return sendError(res, error); }
}

async function updateRole(req, res) {
  try {
    if (!validId(req.params.userId)) return res.status(400).json({ error: "Invalid user ID" });
    const role = validateRole(req.body?.role);
    if (idOf(req.repository.owner) === String(req.params.userId)) return res.status(400).json({ error: "The owner role cannot be changed" });
    const repository = await Repository.findOneAndUpdate(
      { _id: req.repository._id, "collaborators.user": req.params.userId },
      { $set: { "collaborators.$.role": role } }, { new: true },
    );
    if (!repository) return res.status(404).json({ error: "Collaborator not found" });
    await createNotification({ recipient: req.params.userId, actor: req.user.id, repository: repository._id, type: "collaborator_role_changed", title: "Repository role changed", message: `Your role on ${repository.name} is now ${role}.`, url: `/repo/${repository._id}`, eventKey: `collaborator-role:${repository._id}:${req.params.userId}:${role}:${Date.now()}` });
    return res.json({ message: "Collaborator role updated", collaborator: { user: req.params.userId, role } });
  } catch (error) { return sendError(res, error); }
}

async function remove(req, res) {
  try {
    if (!validId(req.params.userId)) return res.status(400).json({ error: "Invalid user ID" });
    if (idOf(req.repository.owner) === String(req.params.userId)) return res.status(400).json({ error: "The repository owner cannot be removed" });
    const result = await Repository.updateOne({ _id: req.repository._id, "collaborators.user": req.params.userId }, { $pull: { collaborators: { user: req.params.userId } } });
    if (!result.modifiedCount) return res.status(404).json({ error: "Collaborator not found" });
    await createNotification({ recipient: req.params.userId, actor: req.user.id, repository: req.repository._id, type: "collaborator_removed", title: "Repository access removed", message: `You were removed from ${req.repository.name}.`, url: "/dashboard", eventKey: `collaborator-removed:${req.repository._id}:${req.params.userId}:${Date.now()}` });
    return res.json({ message: "Collaborator removed" });
  } catch (error) { return sendError(res, error); }
}

async function cancel(req, res) {
  try {
    if (!validId(req.params.invitationId)) return res.status(400).json({ error: "Invalid invitation ID" });
    const invitation = await Invitation.findOneAndUpdate({ _id: req.params.invitationId, repository: req.repository._id, status: "pending" }, { $set: { status: "cancelled", respondedAt: new Date() } }, { new: true });
    if (!invitation) return res.status(404).json({ error: "Pending invitation not found" });
    return res.json({ message: "Invitation cancelled" });
  } catch (error) { return sendError(res, error); }
}

module.exports = {
  invite, listCollaborators, listRepositoryInvitations, listReceived,
  accept: (req, res) => respond(req, res, "accepted"),
  decline: (req, res) => respond(req, res, "declined"),
  updateRole, remove, cancel, safeInvitation, validateRole,
};
