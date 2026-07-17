const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const Invitation = require("../models/repositoryInvitationModel");
const User = require("../models/userModel");
const RepositoryMember = require("../models/repositoryMemberModel");
const RepositoryRoleAudit = require("../models/repositoryRoleAuditModel");
const { createNotification } = require("../services/notificationService");
const { getRepositoryRole, hasRepositoryPermission, resolveRepositoryPermissionContext, permissionSummary } = require("../services/repositoryPermissionService");
const { REPOSITORY_ROLES, ROLE_PERMISSION_MAP, ROLE_DESCRIPTIONS } = require("../constants/repositoryPermissions");
const { validateRepositoryRole, validateAccessConfiguration, assertActorCanAssign, createAudit,
  updateMembership, removeMembership, cleanText } = require("../services/repositoryMemberService");

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
    repositoryRole: value.repositoryRole || ({ read: "viewer", write: "temporary_contributor" }[value.role] || value.role),
    status: value.status,
    message: value.message || "",
    expiresAt: value.expiresAt,
    respondedAt: value.respondedAt || null,
    createdAt: value.createdAt,
    accessStartsAt: value.accessStartsAt || null, accessExpiresAt: value.accessExpiresAt || null,
    allowedBranches: value.allowedBranches || [], retainViewerAfterExpiry: Boolean(value.retainViewerAfterExpiry),
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
  if (error?.code === 11000) return res.status(409).json({ error: "DUPLICATE_MEMBERSHIP", message: "A pending invitation or repository membership already exists" });
  return res.status(error.status || 500).json({ error: error.code || "MEMBER_MANAGEMENT_ERROR", message: error.status ? error.message : "Unable to manage collaborators" });
}

async function invite(req, res) {
  try {
    const repository = req.repository;
    const username = String(req.body?.username || "").trim();
    const role = validateRepositoryRole(req.body?.role);
    const actorRole = req.repositoryRole || getRepositoryRole(repository, req.user.id, req.repositoryMembership);
    assertActorCanAssign(actorRole, role);
    const access = validateAccessConfiguration(role, req.body);
    const message = String(req.body?.message || "").trim();
    if (!req.body?.userId && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}[a-zA-Z0-9])?$/.test(username)) {
      return res.status(400).json({ error: "Enter a valid username" });
    }
    if (message.length > 300) return res.status(400).json({ error: "Invitation message must be 300 characters or fewer" });
    if (req.body?.userId && !validId(req.body.userId)) return res.status(400).json({ error: "Invalid user ID" });
    const invitedUser = req.body?.userId
      ? await User.findById(req.body.userId).select("_id username name avatarUrl")
      : await User.findOne({ username: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }).select("_id username name avatarUrl");
    if (!invitedUser) return res.status(404).json({ error: "User not found" });
    const ownerId = idOf(repository.owner);
    const invitedId = idOf(invitedUser);
    if (invitedId === ownerId) return res.status(400).json({ error: "The repository owner cannot be invited" });
    if (invitedId === String(req.user.id)) return res.status(400).json({ error: "You cannot invite yourself" });
    if ((repository.collaborators || []).some((item) => idOf(item.user) === invitedId)
      || await RepositoryMember.exists({ repository: repository._id, user: invitedUser._id })) {
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
      role: role === "maintainer" ? "maintainer" : (role === "temporary_contributor" ? "write" : "read"),
      repositoryRole: role, ...access, message: cleanText(message, 300),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    await createAudit({ repository: repository._id, targetUser: invitedUser._id, action: "member_invited",
      performedBy: req.user.id, next: { role, status: "active", ...access }, reason: message });
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
    const members = await RepositoryMember.find({ repository: repository._id })
      .populate("user", "_id username name avatarUrl").populate("invitedBy", "_id username name avatarUrl").lean();
    const memberIds = new Set(members.map((member) => idOf(member.user)));
    for (const item of repository.collaborators || []) if (!memberIds.has(idOf(item.user))) members.push({
      user: item.user, role: ({ read: "viewer", write: "temporary_contributor" }[item.role] || item.role), status: "active",
      invitedBy: item.addedBy, joinedAt: item.addedAt, migrationSource: `legacy_${item.role}`,
      legacyIndefiniteAccess: item.role === "write", allowedBranches: [], accessExpiresAt: null,
    });
    const canManage = ["owner", "maintainer"].includes(req.repositoryRole || getRepositoryRole(repository, req.user.id, req.repositoryMembership));
    return res.json({
      owner: safeUser(repository.owner),
      currentUserRole: req.repositoryRole || getRepositoryRole(repository, req.user.id, req.repositoryMembership),
      canManage,
      collaborators: members.map((item) => ({
        _id: item._id, user: safeUser(item.user), role: item.role, status: item.status || "active",
        allowedBranches: item.allowedBranches || [], accessStartsAt: item.accessStartsAt || null,
        accessExpiresAt: item.accessExpiresAt || null, retainViewerAfterExpiry: Boolean(item.retainViewerAfterExpiry),
        migrationSource: item.migrationSource || null, legacyIndefiniteAccess: Boolean(item.legacyIndefiniteAccess),
        invitedBy: safeUser(item.invitedBy), joinedAt: item.joinedAt || item.addedAt,
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
      const role = invitation.repositoryRole || ({ read: "viewer", write: "temporary_contributor" }[invitation.role] || invitation.role);
      const legacyWrite = invitation.role === "write" && !invitation.repositoryRole;
      const access = legacyWrite ? { allowedBranches: [], accessStartsAt: null, accessExpiresAt: null,
        retainViewerAfterExpiry: false, migrationSource: "legacy_write", legacyIndefiniteAccess: true }
        : validateAccessConfiguration(role, invitation.toObject ? invitation.toObject() : invitation);
      const member = await RepositoryMember.findOneAndUpdate(
        { repository: repository._id, user: req.user.id },
        { $setOnInsert: { repository: repository._id, user: req.user.id, role, status: "active", ...access,
          invitedBy: invitation.invitedBy, joinedAt: new Date() } }, { upsert: true, new: true },
      );
      await createAudit({ repository: repository._id, targetUser: req.user.id, action: "member_joined",
        performedBy: invitation.invitedBy, next: member });
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
    const role = validateRepositoryRole(req.body?.role);
    if (idOf(req.repository.owner) === String(req.params.userId)) return res.status(400).json({ error: "The owner role cannot be changed" });
    const member = await RepositoryMember.findOne({ repository: req.repository._id, user: req.params.userId });
    const result = await updateMembership(member, { ...req.body, role }, { userId: req.user.id, role: req.repositoryRole });
    await createNotification({ recipient: req.params.userId, actor: req.user.id, repository: req.repository._id, type: "collaborator_role_changed", title: "Repository role changed", message: `Your role on ${req.repository.name} is now ${role}.`, url: `/repo/${req.repository._id}`, eventKey: `collaborator-role:${req.repository._id}:${req.params.userId}:${role}:${Date.now()}` });
    const summary = permissionSummary(req.repository, req.params.userId, result.member);
    return res.json({ message: "Collaborator role updated", member: result.member, effectiveRole: summary.role,
      status: summary.effectiveStatus, permissions: summary.permissionList, auditRecordId: result.audit?._id });
  } catch (error) { return sendError(res, error); }
}

async function remove(req, res) {
  try {
    if (!validId(req.params.userId)) return res.status(400).json({ error: "Invalid user ID" });
    if (idOf(req.repository.owner) === String(req.params.userId)) return res.status(400).json({ error: "The repository owner cannot be removed" });
    const member = await RepositoryMember.findOne({ repository: req.repository._id, user: req.params.userId });
    await removeMembership(member, { userId: req.user.id, role: req.repositoryRole, reason: req.body?.reason });
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

async function permissionsMe(req, res) {
  try {
    const context = await resolveRepositoryPermissionContext(req.repository, req.user?.id, { membership: req.repositoryMembership });
    const summary = permissionSummary(req.repository, req.user?.id, context.membership);
    return res.json({ role: summary.role || (req.repository.visibility === "public" ? "public" : null),
      status: summary.effectiveStatus, permissions: summary.permissionList, capabilities: summary.capabilities,
      allowedBranches: summary.allowedBranches, accessStartsAt: summary.accessStartsAt,
      accessExpiresAt: summary.accessExpiresAt, retainViewerAfterExpiry: summary.retainViewerAfterExpiry,
      legacyIndefiniteAccess: summary.legacyIndefiniteAccess });
  } catch (error) { return sendError(res, error); }
}

function roles(_req, res) {
  return res.json({ roles: Object.values(REPOSITORY_ROLES).map((role) => ({ role, description: ROLE_DESCRIPTIONS[role], permissions: ROLE_PERMISSION_MAP[role] })) });
}

async function updateAccess(req, res) {
  try {
    if (!validId(req.params.userId)) return res.status(400).json({ error: "Invalid user ID" });
    const member = await RepositoryMember.findOne({ repository: req.repository._id, user: req.params.userId });
    const result = await updateMembership(member, req.body || {}, { userId: req.user.id, role: req.repositoryRole });
    const summary = permissionSummary(req.repository, req.params.userId, result.member);
    return res.json({ message: "Repository access updated", member: result.member, effectiveRole: summary.role,
      status: summary.effectiveStatus, permissions: summary.permissionList, auditRecordId: result.audit?._id });
  } catch (error) { return sendError(res, error); }
}

async function updateStatus(req, res) {
  const status = String(req.body?.status || "");
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: "Status must be active or suspended" });
  return updateAccess({ ...req, body: { status, reason: req.body?.reason } }, res);
}

async function history(req, res) {
  try {
    const filter = { repository: req.repository._id };
    if (req.params.userId) {
      if (!validId(req.params.userId)) return res.status(400).json({ error: "Invalid user ID" });
      filter.targetUser = req.params.userId;
    }
    const audits = await RepositoryRoleAudit.find(filter).sort({ createdAt: -1 }).limit(250)
      .populate("targetUser", "_id username name avatarUrl").populate("performedBy", "_id username name avatarUrl").lean();
    return res.json({ history: audits });
  } catch (error) { return sendError(res, error); }
}

async function memberPermissions(req, res) {
  try {
    if (!validId(req.params.userId)) return res.status(400).json({ error: "Invalid user ID" });
    const member = await RepositoryMember.findOne({ repository: req.repository._id, user: req.params.userId });
    const summary = permissionSummary(req.repository, req.params.userId, member);
    return res.json({ role: summary.role, status: summary.effectiveStatus, permissions: summary.permissionList,
      allowedBranches: summary.allowedBranches, accessExpiresAt: summary.accessExpiresAt });
  } catch (error) { return sendError(res, error); }
}

module.exports = {
  invite, listCollaborators, listRepositoryInvitations, listReceived,
  accept: (req, res) => respond(req, res, "accepted"),
  decline: (req, res) => respond(req, res, "declined"),
  updateRole, updateAccess, updateStatus, remove, cancel, permissionsMe, roles, history, memberPermissions,
  safeInvitation, validateRole, validateRepositoryRole,
};
