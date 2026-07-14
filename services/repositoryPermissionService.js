const ACTIONS = [
  "view", "download", "create_issue", "comment_issue", "create_pr", "review_pr",
  "merge_pr", "create_branch", "write_files", "delete_files", "rename_files",
  "commit", "delete_branch", "manage_issues", "manage_settings",
  "manage_collaborators", "delete_repository", "change_visibility",
];

const PERMISSIONS = {
  owner: new Set(ACTIONS),
  maintainer: new Set([
    "view", "download", "create_issue", "comment_issue", "create_pr", "review_pr",
    "merge_pr", "create_branch", "write_files", "delete_files", "rename_files",
    "commit", "delete_branch", "manage_issues",
  ]),
  write: new Set([
    "view", "download", "create_issue", "comment_issue", "create_pr", "review_pr",
    "create_branch", "write_files", "delete_files", "rename_files", "commit", "delete_branch",
  ]),
  read: new Set(["view", "download", "create_issue", "comment_issue", "create_pr"]),
};

const idOf = (value) => String(value?._id || value?.id || value || "");

function getRepositoryRole(repository, userId) {
  const id = idOf(userId);
  if (!id || !repository) return null;
  if (idOf(repository.owner) === id) return "owner";
  const collaborator = (repository.collaborators || []).find((item) => idOf(item.user) === id);
  return collaborator?.role || null;
}

function hasRepositoryPermission(repository, userId, action) {
  const role = getRepositoryRole(repository, userId);
  return Boolean(role && PERMISSIONS[role]?.has(action));
}

function canViewRepository(repository, userId) {
  return repository?.visibility !== "private" || hasRepositoryPermission(repository, userId, "view");
}

function permissionSummary(repository, userId) {
  const role = getRepositoryRole(repository, userId);
  const has = (action) => hasRepositoryPermission(repository, userId, action);
  return {
    currentUserRole: role,
    permissions: {
      canView: canViewRepository(repository, userId),
      canDownload: has("download"),
      canEditFiles: has("write_files"),
      canUploadFiles: has("write_files"),
      canDeleteFiles: has("delete_files"),
      canRenameFiles: has("rename_files"),
      canCreateBranch: has("create_branch"),
      canDeleteBranch: has("delete_branch"),
      canCreatePullRequest: has("create_pr"),
      canReviewPullRequest: has("review_pr"),
      canMergePullRequest: has("merge_pr"),
      canManageIssues: has("manage_issues"),
      canManageSettings: has("manage_settings"),
      canManageCollaborators: has("manage_collaborators"),
      canDeleteRepository: has("delete_repository"),
      canChangeVisibility: has("change_visibility"),
    },
  };
}

module.exports = {
  ACTIONS, PERMISSIONS, getRepositoryRole, hasRepositoryPermission,
  canViewRepository, permissionSummary,
  canWriteRepository: (repository, userId) => hasRepositoryPermission(repository, userId, "write_files"),
  canManageRepository: (repository, userId) => hasRepositoryPermission(repository, userId, "manage_settings"),
  canManageCollaborators: (repository, userId) => hasRepositoryPermission(repository, userId, "manage_collaborators"),
};
