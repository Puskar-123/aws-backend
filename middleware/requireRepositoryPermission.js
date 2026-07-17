const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const { readAuthenticatedUser } = require("./authMiddleware");
const { assertRepositoryPermission, normalizeBranchName } = require("../services/repositoryPermissionService");
const { isBranchProtected, assertCanDirectWrite, assertCanDeleteBranch } = require("../services/branchProtectionService");
const { REPOSITORY_PERMISSIONS, REPOSITORY_ROLES } = require("../constants/repositoryPermissions");

const P = REPOSITORY_PERMISSIONS;
const WRITE_PERMISSIONS = new Set([P.FILE_CREATE, P.FILE_UPDATE, P.FILE_RENAME, P.FILE_DELETE,
  P.COMMIT_CREATE, P.BRANCH_CREATE, P.BRANCH_PUSH, P.BRANCH_DELETE]);

function defaultRepositoryIdResolver(req) {
  const candidates = [req.params?.repoId, req.params?.repositoryId, req.params?.id,
    req.body?.repositoryId, req.query?.repositoryId].filter((value) => value !== undefined && value !== null && value !== "");
  const unique = [...new Set(candidates.map(String))];
  if (unique.length > 1) throw Object.assign(new Error("Ambiguous repository ID"), { status: 400, code: "INVALID_REPOSITORY_ID" });
  return unique[0] || null;
}

function defaultBranchResolver(req) {
  const value = req.params?.branch ?? req.params?.branchName ?? req.body?.branch ?? req.body?.branchName ?? req.query?.branch;
  return value == null || value === "" ? null : normalizeBranchName(String(value));
}

function sendPermissionError(res, error) {
  const status = error.status || 500;
  return res.status(status).json({ success: false, error: error.code || (status === 500 ? "INTERNAL_ERROR" : "FORBIDDEN"),
    message: status === 500 ? "Internal Server Error" : error.message,
    ...(error.branch ? { branch: error.branch } : {}), ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}) });
}

function requireRepositoryPermission(permission, options = {}) {
  return async function repositoryPermissionMiddleware(req, res, next) {
    try {
      req.user ||= readAuthenticatedUser(req);
      const repositoryId = (options.repositoryIdResolver || defaultRepositoryIdResolver)(req);
      if (!repositoryId || !mongoose.Types.ObjectId.isValid(repositoryId)) {
        return sendPermissionError(res, Object.assign(new Error("Invalid repository ID"), { status: 400, code: "INVALID_REPOSITORY_ID" }));
      }
      const repository = await (options.RepositoryModel || Repository).findById(repositoryId);
      if (!repository) return sendPermissionError(res, Object.assign(new Error("Repository not found"), { status: 404, code: "REPOSITORY_NOT_FOUND" }));
      const branch = (options.branchResolver || defaultBranchResolver)(req);
      const requestedPermissions = [permission, ...(options.anyOf || [])];
      let context; let lastError;
      for (const requestedPermission of requestedPermissions) {
        try {
          context = await assertRepositoryPermission(repository, req.user?.id, requestedPermission, {
            branch, operation: options.actionDescription || requestedPermission,
            allowPublicRead: Boolean(options.allowPublicRead), requireAuthentication: options.requireAuthentication,
            ...(options.serviceOptions || {}),
          });
          break;
        } catch (error) { if (error.code !== "FORBIDDEN") throw error; lastError = error; }
      }
      if (!context) throw lastError;
      if (repository && typeof repository === "object") repository.$repositoryMembership = context.membership;
      if (branch && WRITE_PERMISSIONS.has(permission)) {
        if (context.role === REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR && isBranchProtected(repository, branch)) {
          throw Object.assign(new Error(`Temporary Contributors cannot write directly to protected branch '${branch}'.`), { status: 403, code: "PROTECTED_BRANCH", branch });
        }
        if (permission === P.BRANCH_DELETE) assertCanDeleteBranch(repository, branch, req.user?.id);
        else if (options.enforceBranchProtection !== false && permission !== P.BRANCH_CREATE) assertCanDirectWrite(repository, branch, req.user?.id, options.actionDescription || permission);
      }
      req.repository = repository; req.repositoryMembership = context.membership; req.repositoryRole = context.role;
      req.repositoryPermissions = context.permissions;
      req.repositoryPermissionContext = { status: context.status, branch, checkedAt: context.now };
      return next();
    } catch (error) { return sendPermissionError(res, error); }
  };
}

module.exports = { requireRepositoryPermission, defaultRepositoryIdResolver, defaultBranchResolver, sendPermissionError };
