const REPOSITORY_PERMISSIONS = Object.freeze({
  REPOSITORY_VIEW: "repository:view", REPOSITORY_UPDATE: "repository:update",
  REPOSITORY_DELETE: "repository:delete", REPOSITORY_CHANGE_VISIBILITY: "repository:change_visibility",
  REPOSITORY_VIEW_INSIGHTS: "repository:view_insights", REPOSITORY_MANAGE_SETTINGS: "repository:manage_settings",
  REPOSITORY_MANAGE_BRANCH_PROTECTION: "repository:manage_branch_protection",
  MEMBER_VIEW: "member:view", MEMBER_INVITE: "member:invite", MEMBER_UPDATE_ROLE: "member:update_role",
  MEMBER_UPDATE_ACCESS: "member:update_access", MEMBER_REMOVE: "member:remove",
  MEMBER_VIEW_HISTORY: "member:view_history", MEMBER_ASSIGN_MAINTAINER: "member:assign_maintainer",
  FILE_VIEW: "file:view", FILE_DOWNLOAD: "file:download", FILE_CREATE: "file:create",
  FILE_UPDATE: "file:update", FILE_RENAME: "file:rename", FILE_DELETE: "file:delete",
  COMMIT_VIEW: "commit:view", COMMIT_CREATE: "commit:create",
  BRANCH_VIEW: "branch:view", BRANCH_CREATE: "branch:create", BRANCH_PUSH: "branch:push",
  BRANCH_MERGE: "branch:merge", BRANCH_DELETE: "branch:delete",
  ISSUE_VIEW: "issue:view", ISSUE_CREATE: "issue:create", ISSUE_UPDATE: "issue:update",
  ISSUE_ASSIGN: "issue:assign", ISSUE_CLOSE: "issue:close", ISSUE_REOPEN: "issue:reopen",
  ISSUE_COMMENT: "issue:comment", ISSUE_MANAGE_LABELS: "issue:manage_labels",
  ISSUE_MANAGE_PRIORITY: "issue:manage_priority", ISSUE_MANAGE_MILESTONE: "issue:manage_milestone",
  PULL_VIEW: "pull:view", PULL_CREATE: "pull:create", PULL_COMMENT: "pull:comment",
  PULL_REVIEW: "pull:review", PULL_APPROVE: "pull:approve",
  PULL_REQUEST_CHANGES: "pull:request_changes", PULL_MERGE: "pull:merge",
  TEST_VIEW: "test:view", TEST_RUN: "test:run", TEST_SUBMIT_RESULT: "test:submit_result",
  RELEASE_VIEW: "release:view", RELEASE_CREATE: "release:create", RELEASE_UPDATE: "release:update",
  RELEASE_PUBLISH: "release:publish", RELEASE_DELETE: "release:delete", RELEASE_UPLOAD_ASSET: "release:upload_asset",
  WORKFLOW_VIEW: "workflow:view", WORKFLOW_TRIGGER: "workflow:trigger", WORKFLOW_CANCEL: "workflow:cancel",
  DEPLOYMENT_VIEW: "deployment:view", DEPLOYMENT_TRIGGER: "deployment:trigger",
  DEPLOYMENT_CANCEL: "deployment:cancel", DEPLOYMENT_VIEW_LOGS: "deployment:view_logs",
  DEPLOYMENT_MANAGE_METADATA: "deployment:manage_metadata",
});

const REPOSITORY_ROLES = Object.freeze({
  OWNER: "owner", MAINTAINER: "maintainer", VIEWER: "viewer", ISSUE_MANAGER: "issue_manager",
  TESTER: "tester", REVIEWER: "reviewer", TEMPORARY_CONTRIBUTOR: "temporary_contributor",
  DEPLOYMENT_MANAGER: "deployment_manager",
});

const P = REPOSITORY_PERMISSIONS;
const viewer = [P.REPOSITORY_VIEW, P.REPOSITORY_VIEW_INSIGHTS, P.MEMBER_VIEW, P.FILE_VIEW, P.FILE_DOWNLOAD,
  P.COMMIT_VIEW, P.BRANCH_VIEW, P.ISSUE_VIEW, P.ISSUE_COMMENT, P.PULL_VIEW, P.PULL_COMMENT,
  P.TEST_VIEW, P.RELEASE_VIEW, P.WORKFLOW_VIEW, P.DEPLOYMENT_VIEW];
const sourceWrite = [P.FILE_CREATE, P.FILE_UPDATE, P.FILE_RENAME, P.FILE_DELETE, P.COMMIT_CREATE,
  P.BRANCH_CREATE, P.BRANCH_PUSH, P.BRANCH_MERGE, P.BRANCH_DELETE];
const issues = [P.ISSUE_CREATE, P.ISSUE_UPDATE, P.ISSUE_ASSIGN, P.ISSUE_CLOSE, P.ISSUE_REOPEN,
  P.ISSUE_COMMENT, P.ISSUE_MANAGE_LABELS, P.ISSUE_MANAGE_PRIORITY, P.ISSUE_MANAGE_MILESTONE];
const reviews = [P.PULL_CREATE, P.PULL_REVIEW, P.PULL_APPROVE, P.PULL_REQUEST_CHANGES];
const releases = [P.RELEASE_CREATE, P.RELEASE_UPDATE, P.RELEASE_PUBLISH, P.RELEASE_DELETE, P.RELEASE_UPLOAD_ASSET];
const deployment = [P.DEPLOYMENT_VIEW, P.DEPLOYMENT_TRIGGER, P.DEPLOYMENT_CANCEL, P.DEPLOYMENT_VIEW_LOGS, P.DEPLOYMENT_MANAGE_METADATA];
const all = Object.values(P);

const ROLE_PERMISSION_MAP = Object.freeze({
  [REPOSITORY_ROLES.OWNER]: Object.freeze(all),
  [REPOSITORY_ROLES.MAINTAINER]: Object.freeze([...new Set([...viewer, ...sourceWrite, ...issues, ...reviews,
    P.PULL_MERGE, ...releases, P.WORKFLOW_TRIGGER, P.WORKFLOW_CANCEL, P.REPOSITORY_UPDATE,
    P.REPOSITORY_MANAGE_SETTINGS, P.MEMBER_INVITE, P.MEMBER_UPDATE_ROLE, P.MEMBER_UPDATE_ACCESS,
    P.MEMBER_REMOVE, P.MEMBER_VIEW_HISTORY])]),
  [REPOSITORY_ROLES.VIEWER]: Object.freeze(viewer),
  [REPOSITORY_ROLES.ISSUE_MANAGER]: Object.freeze([...new Set([...viewer, ...issues])]),
  [REPOSITORY_ROLES.TESTER]: Object.freeze([...new Set([...viewer, P.TEST_RUN, P.TEST_SUBMIT_RESULT])]),
  [REPOSITORY_ROLES.REVIEWER]: Object.freeze([...new Set([...viewer, ...reviews])]),
  [REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR]: Object.freeze([...new Set([...viewer, P.PULL_CREATE,
    P.FILE_CREATE, P.FILE_UPDATE, P.FILE_RENAME, P.FILE_DELETE, P.COMMIT_CREATE, P.BRANCH_CREATE, P.BRANCH_PUSH])]),
  [REPOSITORY_ROLES.DEPLOYMENT_MANAGER]: Object.freeze([...new Set([...viewer, ...releases, ...deployment])]),
});

const ROLE_DESCRIPTIONS = Object.freeze({
  owner: "Full repository control.", maintainer: "Code, collaboration, releases, and ordinary settings.",
  viewer: "Read-only repository access.", issue_manager: "Manage issues without source access.",
  tester: "Run permitted tests and record pull-request test results.",
  reviewer: "Review and approve pull requests without merge access.",
  temporary_contributor: "Time-limited source access on explicitly allowed branches.",
  deployment_manager: "Manage releases and deployment workflows without source access.",
});

module.exports = { REPOSITORY_PERMISSIONS, REPOSITORY_ROLES, ROLE_PERMISSION_MAP, ROLE_DESCRIPTIONS };
