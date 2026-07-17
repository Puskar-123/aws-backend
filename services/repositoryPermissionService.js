const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const RepositoryMember = require("../models/repositoryMemberModel");
const RepositoryRoleAudit = require("../models/repositoryRoleAuditModel");
const { REPOSITORY_PERMISSIONS, REPOSITORY_ROLES, ROLE_PERMISSION_MAP } = require("../constants/repositoryPermissions");

const P = REPOSITORY_PERMISSIONS;
const LEGACY_PERMISSION_ALIASES = Object.freeze({
  view: P.REPOSITORY_VIEW, download: P.FILE_DOWNLOAD, create_issue: P.ISSUE_CREATE,
  comment_issue: P.ISSUE_COMMENT, create_pr: P.PULL_CREATE, review_pr: P.PULL_REVIEW,
  merge_pr: P.PULL_MERGE, create_branch: P.BRANCH_CREATE, write_files: P.FILE_UPDATE,
  delete_files: P.FILE_DELETE, rename_files: P.FILE_RENAME, commit: P.COMMIT_CREATE,
  delete_branch: P.BRANCH_DELETE, manage_issues: P.ISSUE_UPDATE,
  manage_settings: P.REPOSITORY_MANAGE_SETTINGS, manage_collaborators: P.MEMBER_INVITE,
  manage_branch_protection: P.REPOSITORY_MANAGE_BRANCH_PROTECTION,
  delete_repository: P.REPOSITORY_DELETE, change_visibility: P.REPOSITORY_CHANGE_VISIBILITY,
  manage_tags: P.RELEASE_UPDATE, manage_releases: P.RELEASE_UPDATE, manage_workflows: P.WORKFLOW_TRIGGER,
});
const ACTIONS = Object.freeze(Object.keys(LEGACY_PERMISSION_ALIASES));
const idOf = (value) => String(value?._id || value?.id || value || "");
const mappedPermission = (permission) => LEGACY_PERMISSION_ALIASES[permission] || permission;
const permissionsForRole = (role) => ROLE_PERMISSION_MAP[role] || [];

function normalizeBranchName(value) {
  if (typeof value !== "string" || value !== value.trim()) throw permissionError("INVALID_ACCESS_CONFIGURATION", "Branch names cannot have leading or trailing whitespace.", 400);
  const branch = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!branch || branch === "*" || branch.startsWith("/") || branch.endsWith("/") || branch.includes("..") || /[\x00-\x1f\x7f~^:?*[\]]/.test(branch)) {
    throw permissionError("INVALID_ACCESS_CONFIGURATION", "Invalid branch name.", 400);
  }
  return branch;
}

function normalizeAllowedBranches(values, { allowEmpty = false, allowWildcard = false } = {}) {
  if (!Array.isArray(values)) throw permissionError("INVALID_ACCESS_CONFIGURATION", "allowedBranches must be an array.", 400);
  const normalized = values.map(normalizeBranchName);
  if (!allowWildcard && normalized.includes("*")) throw permissionError("INVALID_ACCESS_CONFIGURATION", "Wildcard branches are not allowed.", 400);
  if (!allowEmpty && !normalized.length) throw permissionError("INVALID_ACCESS_CONFIGURATION", "Temporary Contributor requires at least one allowed branch.", 400);
  if (new Set(normalized).size !== normalized.length) throw permissionError("INVALID_ACCESS_CONFIGURATION", "Duplicate allowed branches are not permitted.", 400);
  return normalized;
}

function permissionError(code, message, status = 403, extras = {}) {
  return Object.assign(new Error(message), { code, status, ...extras });
}

function isTemporaryAccessStarted(membership, now = new Date()) {
  return !membership?.accessStartsAt || new Date(membership.accessStartsAt) <= now;
}
function isTemporaryAccessExpired(membership, now = new Date()) {
  return Boolean(membership?.accessExpiresAt && new Date(membership.accessExpiresAt) <= now);
}
function isLegacyIndefinite(membership) {
  return membership?.role === REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR
    && membership?.migrationSource === "legacy_write" && membership?.legacyIndefiniteAccess === true
    && !membership?.accessExpiresAt;
}
function getEffectiveMembershipStatus(membership, _repository, now = new Date()) {
  if (!membership) return null;
  if (membership.status === "suspended") return "suspended";
  if (membership.role === REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR && isTemporaryAccessExpired(membership, now)) return "expired";
  if (membership.status === "expired") return "expired";
  if (!isTemporaryAccessStarted(membership, now)) return "not_started";
  return "active";
}

function legacyMembership(repository, userId) {
  const collaborator = (repository?.collaborators || []).find((item) => idOf(item.user) === idOf(userId));
  if (!collaborator) return null;
  const map = { maintainer: "maintainer", read: "viewer", write: "temporary_contributor" };
  return {
    repository: repository._id, user: collaborator.user, role: map[collaborator.role] || collaborator.role,
    status: "active", allowedBranches: [], invitedBy: collaborator.addedBy, joinedAt: collaborator.addedAt,
    migrationSource: `legacy_${collaborator.role}`, legacyIndefiniteAccess: collaborator.role === "write",
    accessStartsAt: null, accessExpiresAt: null, retainViewerAfterExpiry: false, isLegacyFallback: true,
  };
}

function attachedMembership(repository, userId) {
  const member = repository?.repositoryMembership || repository?.$repositoryMembership;
  return member && idOf(member.user) === idOf(userId) ? member : legacyMembership(repository, userId);
}

function getRepositoryRole(repository, userId, membership = attachedMembership(repository, userId), now = new Date()) {
  if (!repository || !idOf(userId)) return null;
  if (idOf(repository.owner) === idOf(userId)) return REPOSITORY_ROLES.OWNER;
  if (!membership || membership.status === "suspended") return null;
  if (membership.role === REPOSITORY_ROLES.OWNER) return null;
  const status = getEffectiveMembershipStatus(membership, repository, now);
  if (status === "not_started") return null;
  if (status === "expired") return membership.retainViewerAfterExpiry ? REPOSITORY_ROLES.VIEWER : null;
  return membership.role;
}

function hasRepositoryPermission(repository, userId, permission, context = {}) {
  const membership = context.membership || attachedMembership(repository, userId);
  const role = getRepositoryRole(repository, userId, membership, context.now || new Date());
  if (permission === "manage_collaborators") return role === REPOSITORY_ROLES.OWNER;
  if (permission === "review_pr" && isLegacyIndefinite(membership)) return true;
  const allowed = permissionsForRole(role).includes(mappedPermission(permission));
  if (!allowed) return false;
  if (role === REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR && context.branch) {
    return canAccessBranch(membership, context.branch, context.operation || permission);
  }
  return true;
}

function canViewRepository(repository, userId, context = {}) {
  return Boolean(repository && (repository.visibility !== "private" || hasRepositoryPermission(repository, userId, P.REPOSITORY_VIEW, context)));
}

function canAccessBranch(membership, branchName) {
  if (!membership || membership.role !== REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR) return true;
  if (isLegacyIndefinite(membership)) return true;
  let branch;
  try { branch = normalizeBranchName(branchName); } catch { return false; }
  return (membership.allowedBranches || []).includes(branch);
}

async function getRepositoryMembership(repositoryId, userId, { MemberModel = RepositoryMember } = {}) {
  if (!mongoose.Types.ObjectId.isValid(repositoryId) || !mongoose.Types.ObjectId.isValid(userId)) return null;
  return MemberModel.findOne({ repository: repositoryId, user: userId });
}

async function markExpiredOnce(membership, now, { MemberModel = RepositoryMember, AuditModel = RepositoryRoleAudit } = {}) {
  if (!membership?._id || membership.status === "expired") return;
  await MemberModel.updateOne({ _id: membership._id, status: { $ne: "expired" } }, { $set: { status: "expired" } }).catch(() => {});
  await AuditModel.updateOne(
    { repository: membership.repository, targetUser: membership.user, action: "temporary_access_expired" },
    { $setOnInsert: { repository: membership.repository, targetUser: membership.user, action: "temporary_access_expired",
      previousRole: membership.role, newRole: membership.role, previousStatus: membership.status,
      newStatus: "expired", newAccessExpiresAt: membership.accessExpiresAt, createdAt: now } },
    { upsert: true },
  ).catch(() => {});
}

async function resolveRepositoryPermissionContext(repositoryOrId, userId, options = {}) {
  const RepositoryModel = options.RepositoryModel || Repository;
  const MemberModel = options.MemberModel || RepositoryMember;
  const repository = typeof repositoryOrId === "object" && repositoryOrId && ("owner" in repositoryOrId || "visibility" in repositoryOrId)
    ? repositoryOrId : await RepositoryModel.findById(repositoryOrId);
  if (!repository) throw permissionError("REPOSITORY_NOT_FOUND", "Repository not found", 404);
  const now = options.now || new Date();
  let membership = null;
  if (idOf(userId) && idOf(repository.owner) !== idOf(userId)) {
    if (options.membership !== undefined) membership = options.membership;
    else if (mongoose.connection.readyState === 1 || options.MemberModel) membership = await getRepositoryMembership(repository._id, userId, { MemberModel });
    membership ||= legacyMembership(repository, userId);
  }
  const rawStatus = getEffectiveMembershipStatus(membership, repository, now);
  if (rawStatus === "expired" && membership?._id && !options.skipExpirationWrite) {
    await markExpiredOnce(membership, now, { MemberModel, AuditModel: options.AuditModel || RepositoryRoleAudit });
  }
  const role = getRepositoryRole(repository, userId, membership, now);
  const permissions = [...permissionsForRole(role)];
  return { repository, membership, role, permissions, status: rawStatus, now, isPublicVisitor: !role && repository.visibility !== "private" };
}

async function getEffectiveRepositoryRole(repositoryId, userId, options) {
  return (await resolveRepositoryPermissionContext(repositoryId, userId, options)).role;
}
async function getEffectiveRepositoryPermissions(repositoryId, userId, options) {
  return (await resolveRepositoryPermissionContext(repositoryId, userId, options)).permissions;
}
async function assertRepositoryPermission(repositoryId, userId, permission, context = {}) {
  const resolved = await resolveRepositoryPermissionContext(repositoryId, userId, context);
  const requested = mappedPermission(permission);
  const publicRead = context.allowPublicRead && requested === P.REPOSITORY_VIEW && resolved.repository.visibility !== "private";
  if (publicRead) return resolved;
  if (!userId) throw permissionError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
  if (resolved.status === "not_started") throw permissionError("ACCESS_NOT_STARTED", "Temporary repository access has not started.");
  if (resolved.status === "expired" && !resolved.membership?.retainViewerAfterExpiry) {
    throw permissionError("ACCESS_EXPIRED", `Temporary repository access expired${resolved.membership?.accessExpiresAt ? ` on ${new Date(resolved.membership.accessExpiresAt).toISOString()}` : ""}.`);
  }
  if (!resolved.permissions.includes(requested)) throw permissionError("FORBIDDEN", `${resolved.role ? `${resolved.role.replaceAll("_", " ")} role` : "This account"} does not have ${requested} permission.`);
  if (context.branch && resolved.role === REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR && !canAccessBranch(resolved.membership, context.branch, permission)) {
    throw permissionError("BRANCH_NOT_ALLOWED", `Branch ${context.branch} is not included in your allowed branches.`, 403, { branch: context.branch });
  }
  return resolved;
}

async function hasEffectiveRepositoryPermission(repositoryId, userId, permission, context = {}) {
  try { await assertRepositoryPermission(repositoryId, userId, permission, context); return true; } catch { return false; }
}

function permissionSummary(repository, userId, membership = attachedMembership(repository, userId)) {
  const role = getRepositoryRole(repository, userId, membership);
  const permissions = [...permissionsForRole(role)];
  const has = (permission) => permissions.includes(mappedPermission(permission));
  const capabilities = { canView: canViewRepository(repository, userId, { membership }), canDownload: has(P.FILE_DOWNLOAD),
      canEditFiles: has(P.FILE_UPDATE), canUploadFiles: has(P.FILE_CREATE), canDeleteFiles: has(P.FILE_DELETE),
      canRenameFiles: has(P.FILE_RENAME), canCreateBranch: has(P.BRANCH_CREATE), canDeleteBranch: has(P.BRANCH_DELETE),
      canCreatePullRequest: has(P.PULL_CREATE), canReviewPullRequest: has(P.PULL_REVIEW),
      canMergePullRequest: has(P.PULL_MERGE), canManageIssues: has(P.ISSUE_UPDATE),
      canManageSettings: has(P.REPOSITORY_MANAGE_SETTINGS), canManageCollaborators: role === REPOSITORY_ROLES.OWNER,
      canManageBranchProtection: has(P.REPOSITORY_MANAGE_BRANCH_PROTECTION), canDeleteRepository: has(P.REPOSITORY_DELETE),
      canChangeVisibility: has(P.REPOSITORY_CHANGE_VISIBILITY), canManageTags: has(P.RELEASE_UPDATE),
      canManageReleases: has(P.RELEASE_UPDATE), canManageWorkflows: has(P.WORKFLOW_TRIGGER) };
  return { currentUserRole: role, role, permissionList: permissions, permissions: capabilities,
    effectiveStatus: getEffectiveMembershipStatus(membership, repository),
    allowedBranches: membership?.allowedBranches || [], accessStartsAt: membership?.accessStartsAt || null,
    accessExpiresAt: membership?.accessExpiresAt || null, retainViewerAfterExpiry: Boolean(membership?.retainViewerAfterExpiry),
    legacyIndefiniteAccess: isLegacyIndefinite(membership), capabilities };
}

const PERMISSIONS = Object.freeze(Object.fromEntries(Object.entries(ROLE_PERMISSION_MAP).map(([role, list]) => [role, new Set([...list, ...ACTIONS.filter((a) => list.includes(mappedPermission(a)))])])));
module.exports = { ACTIONS, PERMISSIONS, LEGACY_PERMISSION_ALIASES, getRepositoryRole, hasRepositoryPermission,
  hasEffectiveRepositoryPermission, canViewRepository, permissionSummary, getRepositoryMembership,
  getEffectiveRepositoryRole, getEffectiveRepositoryPermissions, assertRepositoryPermission,
  resolveRepositoryPermissionContext, isTemporaryAccessStarted, isTemporaryAccessExpired,
  getEffectiveMembershipStatus, canAccessBranch, normalizeBranchName, normalizeAllowedBranches,
  isLegacyIndefinite, permissionError, permissionsForRole,
  canWriteRepository: (repository, userId) => hasRepositoryPermission(repository, userId, P.FILE_UPDATE),
  canManageRepository: (repository, userId) => hasRepositoryPermission(repository, userId, P.REPOSITORY_MANAGE_SETTINGS),
  canManageCollaborators: (repository, userId) => hasRepositoryPermission(repository, userId, P.MEMBER_INVITE),
};
