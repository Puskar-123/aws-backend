const { readAuthenticatedUser } = require("../middleware/authMiddleware");
const { requireRepositoryPermission: createPermissionMiddleware, sendPermissionError } = require("../middleware/requireRepositoryPermission");
const { REPOSITORY_PERMISSIONS } = require("../constants/repositoryPermissions");
const { resolveRepositoryPermissionContext } = require("../services/repositoryPermissionService");

const P = REPOSITORY_PERMISSIONS;
const requireRepositoryRead = createPermissionMiddleware(P.REPOSITORY_VIEW, { allowPublicRead: true, requireAuthentication: false });
const requireRepositoryWrite = createPermissionMiddleware(P.FILE_UPDATE, { branchResolver: (req) => req.params?.branchName || req.body?.branch || req.body?.branchName || req.body?.name || null });
const requireRepositoryPermission = (permission, options) => createPermissionMiddleware(permission, options);

async function getAccessibleRepository(req, id, { write = false, action = null } = {}) {
  req.user ||= readAuthenticatedUser(req);
  const context = await resolveRepositoryPermissionContext(id, req.user?.id);
  const middleware = createPermissionMiddleware(action || (write ? P.FILE_UPDATE : P.REPOSITORY_VIEW), {
    allowPublicRead: !write && !action, requireAuthentication: Boolean(write || action),
  });
  let errorResponse;
  await middleware({ ...req, params: { ...(req.params || {}), id } }, {
    status(code) { errorResponse = { status: code }; return this; }, json(body) { errorResponse.body = body; return this; },
  }, () => {});
  if (errorResponse) throw Object.assign(new Error(errorResponse.body.message), { status: errorResponse.status, code: errorResponse.body.error });
  return context.repository;
}

function getAuthenticatedUserId(req) { return readAuthenticatedUser(req)?.id || null; }
function sendAccessError(res, error) { return sendPermissionError(res, error); }

module.exports = { getAccessibleRepository, sendAccessError, getAuthenticatedUserId,
  requireRepositoryRead, requireRepositoryWrite, requireRepositoryPermission };
