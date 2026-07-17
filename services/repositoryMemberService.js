const mongoose = require("mongoose");
const RepositoryMember = require("../models/repositoryMemberModel");
const RepositoryRoleAudit = require("../models/repositoryRoleAuditModel");
const { REPOSITORY_ROLES } = require("../constants/repositoryPermissions");
const { normalizeAllowedBranches, permissionError } = require("./repositoryPermissionService");

const ASSIGNABLE_ROLES = Object.freeze(Object.values(REPOSITORY_ROLES).filter((role) => role !== REPOSITORY_ROLES.OWNER));
const idOf = (value) => String(value?._id || value?.id || value || "");
const cleanText = (value, max = 500) => String(value || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, max);

function validateRepositoryRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!ASSIGNABLE_ROLES.includes(role)) throw permissionError("INVALID_ROLE", "Select a valid built-in repository role.", 400);
  return role;
}

function validateAccessConfiguration(role, input = {}, now = new Date()) {
  if (input.permissions !== undefined) throw permissionError("INVALID_ACCESS_CONFIGURATION", "Custom permissions are not accepted in Phase 1.", 400);
  if (role !== REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR) return {
    allowedBranches: [], accessStartsAt: null, accessExpiresAt: null, retainViewerAfterExpiry: false,
    legacyIndefiniteAccess: false,
  };
  const accessStartsAt = input.accessStartsAt ? new Date(input.accessStartsAt) : now;
  const accessExpiresAt = input.accessExpiresAt ? new Date(input.accessExpiresAt) : null;
  if (Number.isNaN(accessStartsAt.getTime()) || !accessExpiresAt || Number.isNaN(accessExpiresAt.getTime()) || accessExpiresAt <= now || accessExpiresAt <= accessStartsAt) {
    throw permissionError("INVALID_ACCESS_CONFIGURATION", "Temporary Contributor requires a future expiration after its start time.", 400);
  }
  return { allowedBranches: normalizeAllowedBranches(input.allowedBranches), accessStartsAt, accessExpiresAt,
    retainViewerAfterExpiry: input.retainViewerAfterExpiry === true, legacyIndefiniteAccess: false };
}

function assertActorCanAssign(actorRole, targetRole, currentRole = null) {
  if (![REPOSITORY_ROLES.OWNER, REPOSITORY_ROLES.MAINTAINER].includes(actorRole)) throw permissionError("FORBIDDEN", "Repository role management permission is required.");
  if (targetRole === REPOSITORY_ROLES.OWNER) throw permissionError("OWNER_REQUIRED", "Ownership cannot be assigned through the role API.");
  if (actorRole !== REPOSITORY_ROLES.OWNER && (targetRole === REPOSITORY_ROLES.MAINTAINER || currentRole === REPOSITORY_ROLES.MAINTAINER)) {
    throw permissionError("OWNER_REQUIRED", "Only the repository Owner can assign or change a Maintainer role.");
  }
}

function auditSnapshot(member, prefix) {
  return { [`${prefix}Role`]: member?.role, [`${prefix}Status`]: member?.status,
    [`${prefix}AccessStartsAt`]: member?.accessStartsAt, [`${prefix}AccessExpiresAt`]: member?.accessExpiresAt,
    [`${prefix}AllowedBranches`]: member?.allowedBranches || [],
    [`${prefix}RetainViewerAfterExpiry`]: Boolean(member?.retainViewerAfterExpiry) };
}

async function createAudit({ repository, targetUser, action, performedBy, previous, next, reason, metadata }, { AuditModel = RepositoryRoleAudit } = {}) {
  return AuditModel.create({ repository, targetUser, action, performedBy, ...auditSnapshot(previous, "previous"),
    ...auditSnapshot(next, "new"), reason: cleanText(reason), metadata });
}

async function createMembership(input, dependencies = {}) {
  const MemberModel = dependencies.MemberModel || RepositoryMember;
  const role = validateRepositoryRole(input.role); const access = validateAccessConfiguration(role, input, input.now || new Date());
  assertActorCanAssign(input.actorRole, role);
  const member = await MemberModel.create({ repository: input.repository, user: input.user, role, status: "active", ...access,
    invitedBy: input.performedBy || null, joinedAt: input.joinedAt || new Date() });
  const audit = await createAudit({ repository: input.repository, targetUser: input.user, action: input.action || "member_joined",
    performedBy: input.performedBy, next: member, reason: input.reason }, dependencies);
  return { member, audit };
}

async function updateMembership(member, changes, actor, dependencies = {}) {
  const MemberModel = dependencies.MemberModel || RepositoryMember;
  if (!member) throw permissionError("MEMBER_NOT_FOUND", "Repository member not found.", 404);
  if (idOf(member.user) === idOf(actor.userId)) throw permissionError("FORBIDDEN", "You cannot change your own repository role.");
  const role = changes.role ? validateRepositoryRole(changes.role) : member.role;
  assertActorCanAssign(actor.role, role, member.role);
  const previous = member.toObject ? member.toObject() : { ...member };
  const access = changes.role || role === REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR
    ? validateAccessConfiguration(role, { ...previous, ...changes }, changes.now || new Date()) : {};
  const accessChanged = ["accessStartsAt", "accessExpiresAt", "allowedBranches", "retainViewerAfterExpiry"].some((key) => changes[key] !== undefined);
  Object.assign(member, changes, access, { role });
  if (changes.role || accessChanged || changes.accessExpiresAt !== undefined) member.status = changes.status === "suspended" ? "suspended" : "active";
  member.permissions = undefined; member.legacyIndefiniteAccess = false; member.migrationSource = previous.migrationSource || null;
  await member.save();
  const extended = changes.accessExpiresAt && previous.accessExpiresAt && new Date(changes.accessExpiresAt) > new Date(previous.accessExpiresAt);
  const action = role !== previous.role ? "role_changed" : (extended ? "temporary_access_extended" : (accessChanged ? "access_changed" : (member.status === "suspended" ? "member_suspended" : "member_reactivated")));
  const audit = await createAudit({ repository: member.repository, targetUser: member.user, action, performedBy: actor.userId,
    previous, next: member, reason: changes.reason }, dependencies);
  return { member, audit };
}

async function removeMembership(member, actor, dependencies = {}) {
  const MemberModel = dependencies.MemberModel || RepositoryMember;
  if (!member) throw permissionError("MEMBER_NOT_FOUND", "Repository member not found.", 404);
  if (idOf(member.user) === idOf(actor.userId)) throw permissionError("FORBIDDEN", "You cannot remove yourself from this endpoint.");
  assertActorCanAssign(actor.role, REPOSITORY_ROLES.VIEWER, member.role);
  await MemberModel.deleteOne({ _id: member._id, role: { $ne: REPOSITORY_ROLES.OWNER } });
  return createAudit({ repository: member.repository, targetUser: member.user, action: "member_removed",
    performedBy: actor.userId, previous: member, reason: actor.reason }, dependencies);
}

module.exports = { ASSIGNABLE_ROLES, validateRepositoryRole, validateAccessConfiguration, assertActorCanAssign,
  createAudit, createMembership, updateMembership, removeMembership, cleanText };
