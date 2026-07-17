const express = require("express");
const multer = require("multer");

const repoController = require("../controllers/repoController");
const { pushRepo } = require("../controllers/push");
const { addFiles } = require("../controllers/addController");
const { createCommit } = require("../controllers/commitController");
const { getFile } = require("../controllers/fileController");
const { pullRepo } = require("../controllers/pull");
const { getCommitHistory } = require("../controllers/historyController");
const { getCommitDiff } = require("../controllers/diffController");
const { getBrowserStatus } = require("../controllers/browserStatusController");
const { previewFile } = require("../controllers/previewController");
const { deleteFile, renameFile } = require("../controllers/fileManageController");
const { listBranches, createBranch, deleteBranch } = require("../controllers/branchController");
const { getSnapshot, getSnapshotFile } = require("../controllers/snapshotController");
const { compareBranches } = require("../controllers/compareController");
const pullRequestController = require("../controllers/pullRequestController");
const advancedReviewController = require("../controllers/advancedReviewController");
const repositoryInsightsController = require("../controllers/repositoryInsightsController");
const issueController = require("../controllers/issueController");
const socialController = require("../controllers/repositorySocialController");
const fileEditController = require("../controllers/fileEditController");
const publicDiscoveryController = require("../controllers/publicDiscoveryController");
const collaboratorController = require("../controllers/repositoryCollaboratorController");
const branchProtectionController = require("../controllers/branchProtectionController");
const repositoryCliController = require("../controllers/repositoryCliController");
const tagController = require("../controllers/tagController");
const releaseController = require("../controllers/releaseController");
const workflowController = require("../controllers/workflowController");
const pullRequestTestResultController = require("../controllers/pullRequestTestResultController");
const { workflowRateLimit } = require("../middleware/workflowRateLimit");
const { optionalAuth, requireAuth } = require("../middleware/authMiddleware");
const repositoryAccess = require("../utils/repositoryAccess");
const { requireRepositoryRead, requireRepositoryWrite } = repositoryAccess;
const requireRepositoryPermission = repositoryAccess.requireRepositoryPermission
  || (() => requireRepositoryWrite);
const { REPOSITORY_PERMISSIONS: P } = require("../constants/repositoryPermissions");
const { invalidateRepositoryHealthCache } = require("../services/repositoryHealthService");
const branchFromManifest = (req) => {
  try { return JSON.parse(String(req.body?.manifest || "")).branch || null; } catch { return null; }
};

const repoRouter = express.Router();
repoRouter.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const match = req.originalUrl.match(/\/repo\/([^/?]+)/);
  if (match) res.on("finish", () => { if (res.statusCode < 400) invalidateRepositoryHealthCache(match[1]); });
  return next();
});
const upload = multer({ dest: "uploads/" });
const cliUpload = multer({ dest: "uploads/", limits: { fileSize: 25 * 1024 * 1024, files: 500, fields: 20 } });
const receiveCliPush = (req, res, next) => cliUpload.array("files")(req, res, (error) => {
  if (!error) return next();
  const tooLarge = error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT";
  return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Push exceeds the configured file limits" : "Invalid push upload", code: tooLarge ? "FILE_TOO_LARGE" : "INVALID_PUSH" });
});
const releaseUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10 } });
const receiveReleaseAsset = (req, res, next) => releaseUpload.single("asset")(req, res, (error) => {
  if (!error) return next();
  const tooLarge = error.code === "LIMIT_FILE_SIZE";
  return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Asset exceeds the 100 MB limit" : "Invalid release asset upload", code: tooLarge ? "ASSET_TOO_LARGE" : "INVALID_ASSET_UPLOAD" });
});

// Existing write workflows.
repoRouter.post("/add/:id", requireAuth, upload.array("files"), requireRepositoryPermission(P.FILE_CREATE, { branchResolver: (req) => req.body?.branch }), addFiles);
repoRouter.post("/commit/:id", requireRepositoryPermission(P.COMMIT_CREATE, { branchResolver: (req) => req.body?.branch }), createCommit);
repoRouter.post("/push/:id", requireRepositoryPermission(P.BRANCH_PUSH, { branchResolver: (req) => req.body?.branch }), pushRepo);
repoRouter.post("/pull/:id", requireRepositoryRead, pullRepo);
repoRouter.post("/create", requireAuth, repoController.createRepository);
repoRouter.post("/:id/star", requireAuth, requireRepositoryRead, socialController.star);
repoRouter.delete("/:id/star", requireAuth, requireRepositoryRead, socialController.unstar);
repoRouter.get("/:id/star-status", optionalAuth, requireRepositoryRead, socialController.status);
repoRouter.post("/:id/watch", requireAuth, requireRepositoryRead, socialController.watch);
repoRouter.delete("/:id/watch", requireAuth, requireRepositoryRead, socialController.unwatch);
repoRouter.get("/:id/watch-status", optionalAuth, requireRepositoryRead, socialController.status);
repoRouter.post("/:id/fork", requireAuth, requireRepositoryRead, socialController.fork);
repoRouter.get("/:id/file-editor", requireRepositoryPermission(P.FILE_UPDATE, { branchResolver: (req) => req.query?.branch }), fileEditController.read);
repoRouter.post("/:id/file-editor", requireRepositoryPermission(P.FILE_CREATE, { branchResolver: (req) => req.body?.branch }), fileEditController.create);
repoRouter.put("/:id/file-editor", requireRepositoryPermission(P.FILE_UPDATE, { branchResolver: (req) => req.body?.branch }), fileEditController.update);
repoRouter.get("/:id/branch-protection", requireAuth, requireRepositoryPermission(P.REPOSITORY_MANAGE_BRANCH_PROTECTION), branchProtectionController.list);
repoRouter.post("/:id/branch-protection", requireAuth, requireRepositoryPermission(P.REPOSITORY_MANAGE_BRANCH_PROTECTION), branchProtectionController.create);
repoRouter.patch("/:id/branch-protection/:branch", requireAuth, requireRepositoryPermission(P.REPOSITORY_MANAGE_BRANCH_PROTECTION), branchProtectionController.update);
repoRouter.delete("/:id/branch-protection/:branch", requireAuth, requireRepositoryPermission(P.REPOSITORY_MANAGE_BRANCH_PROTECTION), branchProtectionController.remove);
repoRouter.post("/:id/collaborators/invitations", requireAuth, requireRepositoryPermission(P.MEMBER_INVITE), collaboratorController.invite);
repoRouter.get("/:id/collaborators", requireAuth, requireRepositoryRead, collaboratorController.listCollaborators);
repoRouter.get("/:id/collaborators/invitations", requireAuth, requireRepositoryPermission(P.MEMBER_INVITE), collaboratorController.listRepositoryInvitations);
repoRouter.patch("/:id/collaborators/:userId", requireAuth, requireRepositoryPermission(P.MEMBER_UPDATE_ROLE), collaboratorController.updateRole);
repoRouter.delete("/:id/collaborators/:userId", requireAuth, requireRepositoryPermission(P.MEMBER_REMOVE), collaboratorController.remove);
repoRouter.delete("/:id/collaborators/invitations/:invitationId", requireAuth, requireRepositoryPermission(P.MEMBER_INVITE), collaboratorController.cancel);
repoRouter.get("/:id/members", requireAuth, requireRepositoryPermission(P.MEMBER_VIEW), collaboratorController.listCollaborators);
repoRouter.post("/:id/members/invite", requireAuth, requireRepositoryPermission(P.MEMBER_INVITE), collaboratorController.invite);
repoRouter.patch("/:id/members/:userId/role", requireAuth, requireRepositoryPermission(P.MEMBER_UPDATE_ROLE), collaboratorController.updateRole);
repoRouter.patch("/:id/members/:userId/access", requireAuth, requireRepositoryPermission(P.MEMBER_UPDATE_ACCESS), collaboratorController.updateAccess);
repoRouter.patch("/:id/members/:userId/status", requireAuth, requireRepositoryPermission(P.MEMBER_UPDATE_ACCESS), collaboratorController.updateStatus);
repoRouter.delete("/:id/members/:userId", requireAuth, requireRepositoryPermission(P.MEMBER_REMOVE), collaboratorController.remove);
repoRouter.get("/:id/roles", optionalAuth, requireRepositoryRead, collaboratorController.roles);
repoRouter.get("/:id/permissions/me", optionalAuth, requireRepositoryRead, collaboratorController.permissionsMe);
repoRouter.get("/:id/members/:userId/permissions", requireAuth, requireRepositoryPermission(P.MEMBER_VIEW), collaboratorController.memberPermissions);
repoRouter.get("/:id/role-history", requireAuth, requireRepositoryPermission(P.MEMBER_VIEW_HISTORY), collaboratorController.history);
repoRouter.get("/:id/role-history/:userId", requireAuth, requireRepositoryPermission(P.MEMBER_VIEW_HISTORY), collaboratorController.history);

// Tags and releases reference canonical embedded commits and stay before /:id.
repoRouter.get("/:id/tags", optionalAuth, requireRepositoryRead, tagController.list);
repoRouter.post("/:id/tags", requireAuth, requireRepositoryPermission(P.RELEASE_CREATE), tagController.create);
repoRouter.get("/:id/tags/:tagName", optionalAuth, requireRepositoryRead, tagController.details);
repoRouter.patch("/:id/tags/:tagName", requireAuth, requireRepositoryPermission(P.RELEASE_UPDATE), tagController.update);
repoRouter.delete("/:id/tags/:tagName", requireAuth, requireRepositoryPermission(P.RELEASE_DELETE), tagController.remove);
repoRouter.get("/:id/tags/:tagName/source.zip", optionalAuth, requireRepositoryRead, releaseController.sourceArchive);
repoRouter.get("/:id/releases", optionalAuth, requireRepositoryRead, releaseController.list);
repoRouter.post("/:id/releases", requireAuth, requireRepositoryPermission(P.RELEASE_CREATE), releaseController.create);
repoRouter.get("/:id/releases/latest", optionalAuth, requireRepositoryRead, releaseController.latest);
repoRouter.get("/:id/releases/:releaseId/source.zip", optionalAuth, requireRepositoryRead, releaseController.sourceArchive);
repoRouter.get("/:id/releases/:releaseId", optionalAuth, requireRepositoryRead, releaseController.details);
repoRouter.patch("/:id/releases/:releaseId", requireAuth, requireRepositoryPermission(P.RELEASE_UPDATE), releaseController.update);
repoRouter.delete("/:id/releases/:releaseId", requireAuth, requireRepositoryPermission(P.RELEASE_DELETE), releaseController.remove);
repoRouter.post("/:id/releases/:releaseId/publish", requireAuth, requireRepositoryPermission(P.RELEASE_PUBLISH), releaseController.publish);
repoRouter.post("/:id/releases/:releaseId/assets", requireAuth, requireRepositoryPermission(P.RELEASE_UPLOAD_ASSET), receiveReleaseAsset, releaseController.uploadAsset);
repoRouter.get("/:id/releases/:releaseId/assets/:assetId/download", optionalAuth, requireRepositoryRead, releaseController.downloadAsset);
repoRouter.delete("/:id/releases/:releaseId/assets/:assetId", requireAuth, requireRepositoryPermission(P.RELEASE_UPDATE), releaseController.deleteAsset);

// Actions APIs only queue work; the Express process never executes repository commands.
repoRouter.get("/:id/actions/workflows", optionalAuth, requireRepositoryRead, workflowController.workflows);
repoRouter.get("/:id/actions/runs", optionalAuth, requireRepositoryRead, workflowController.runs);
repoRouter.post("/:id/actions/workflows/:workflowId/dispatch", requireAuth, requireRepositoryPermission(P.WORKFLOW_TRIGGER, { anyOf: [P.TEST_RUN, P.DEPLOYMENT_TRIGGER] }), workflowRateLimit(), workflowController.dispatch);
repoRouter.get("/:id/actions/runs/:runId/logs", optionalAuth, requireRepositoryRead, workflowController.logs);
repoRouter.get("/:id/actions/runs/:runId", optionalAuth, requireRepositoryRead, workflowController.details);
repoRouter.post("/:id/actions/runs/:runId/cancel", requireAuth, requireRepositoryPermission(P.WORKFLOW_CANCEL, { anyOf: [P.DEPLOYMENT_CANCEL] }), workflowRateLimit(), workflowController.cancel);
repoRouter.post("/:id/actions/runs/:runId/rerun", requireAuth, requireRepositoryPermission(P.WORKFLOW_TRIGGER), workflowRateLimit(), workflowController.rerun);

// Branch, history, and clone/snapshot APIs. Keep these before /:id.
repoRouter.get("/explore", publicDiscoveryController.explore);
repoRouter.get("/resolve/:owner/:name", optionalAuth, repositoryCliController.resolve);
repoRouter.get("/:id/cli/metadata", optionalAuth, requireRepositoryRead, repositoryCliController.metadata);
repoRouter.get("/:id/cli/fetch", optionalAuth, requireRepositoryRead, repositoryCliController.metadata);
repoRouter.post("/:id/cli/push", requireAuth, receiveCliPush, requireRepositoryPermission(P.BRANCH_PUSH, { branchResolver: branchFromManifest }), repositoryCliController.push);
repoRouter.get("/:id/compare", requireRepositoryRead, compareBranches);
repoRouter.post("/:id/issues", requireAuth, requireRepositoryPermission(P.ISSUE_CREATE), issueController.create);
repoRouter.get("/:id/issues", optionalAuth, requireRepositoryRead, issueController.list);
repoRouter.get("/:id/issues/:number", optionalAuth, requireRepositoryRead, issueController.details);
repoRouter.patch("/:id/issues/:number", requireAuth, requireRepositoryPermission(P.ISSUE_UPDATE), issueController.update);
repoRouter.post("/:id/issues/:number/comments", requireAuth, requireRepositoryRead, issueController.comment);
repoRouter.post("/:id/issues/:number/close", requireAuth, requireRepositoryPermission(P.ISSUE_CLOSE), issueController.close);
repoRouter.post("/:id/issues/:number/reopen", requireAuth, requireRepositoryPermission(P.ISSUE_REOPEN), issueController.reopen);
repoRouter.post("/:id/issues/:number/labels", requireAuth, requireRepositoryPermission(P.ISSUE_MANAGE_LABELS), issueController.addLabel);
repoRouter.delete("/:id/issues/:number/labels/:labelName", requireAuth, requireRepositoryPermission(P.ISSUE_MANAGE_LABELS), issueController.removeLabel);
repoRouter.post("/:id/issues/:number/assignees", requireAuth, requireRepositoryPermission(P.ISSUE_ASSIGN), issueController.addAssignee);
repoRouter.delete("/:id/issues/:number/assignees/:userId", requireAuth, requireRepositoryPermission(P.ISSUE_ASSIGN), issueController.removeAssignee);
repoRouter.post("/:id/issues/:number/link-pr", requireAuth, requireRepositoryPermission(P.ISSUE_UPDATE), issueController.linkPullRequest);
repoRouter.post("/:id/pulls", requireAuth, requireRepositoryPermission(P.PULL_CREATE), pullRequestController.create);
repoRouter.get("/:id/pulls", optionalAuth, requireRepositoryRead, pullRequestController.list);
repoRouter.get("/:id/pulls/:number", optionalAuth, requireRepositoryRead, pullRequestController.details);
repoRouter.get("/:id/pulls/:number/checks", optionalAuth, requireRepositoryRead, workflowController.pullChecks);
repoRouter.get("/:id/pulls/:number/test-results", optionalAuth, requireRepositoryRead, pullRequestTestResultController.list);
repoRouter.post("/:id/pulls/:number/test-results", requireAuth, requireRepositoryPermission(P.TEST_SUBMIT_RESULT), pullRequestTestResultController.create);
repoRouter.patch("/:id/pulls/:number", requireAuth, requireRepositoryPermission(P.PULL_CREATE), pullRequestController.update);
repoRouter.post("/:id/pulls/:number/comments", requireAuth, requireRepositoryPermission(P.PULL_COMMENT), pullRequestController.comment);
repoRouter.get("/:id/pulls/:number/reviews", optionalAuth, requireRepositoryRead, pullRequestController.listReviews);
repoRouter.post("/:id/pulls/:number/reviews", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), pullRequestController.review);
repoRouter.get("/:id/pulls/:number/reviewers", optionalAuth, requireRepositoryRead, advancedReviewController.reviewers);
repoRouter.post("/:id/pulls/:number/reviewers", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.requestReviewer);
repoRouter.delete("/:id/pulls/:number/reviewers/:userId", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.removeReviewer);
repoRouter.get("/:id/pulls/:number/files", optionalAuth, requireRepositoryRead, advancedReviewController.files);
repoRouter.post("/:id/pulls/:number/threads", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.createThread);
repoRouter.post("/:id/pulls/:number/threads/:threadId/comments", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.reply);
repoRouter.patch("/:id/pulls/:number/comments/:commentId", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.editComment);
repoRouter.delete("/:id/pulls/:number/comments/:commentId", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.deleteComment);
repoRouter.patch("/:id/pulls/:number/threads/:threadId/resolve", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.resolve);
repoRouter.patch("/:id/pulls/:number/threads/:threadId/reopen", requireAuth, requireRepositoryPermission(P.PULL_REVIEW), advancedReviewController.reopen);
repoRouter.get("/:id/pulls/:number/merge-status", optionalAuth, requireRepositoryRead, advancedReviewController.mergeStatus);
repoRouter.get("/:id/insights/overview", optionalAuth, requireRepositoryRead, repositoryInsightsController.overview);
repoRouter.get("/:id/insights/health", optionalAuth, requireRepositoryRead, repositoryInsightsController.health);
repoRouter.get("/:id/insights/commits", optionalAuth, requireRepositoryRead, repositoryInsightsController.commits);
repoRouter.get("/:id/insights/contributors", optionalAuth, requireRepositoryRead, repositoryInsightsController.contributors);
repoRouter.get("/:id/insights/languages", optionalAuth, requireRepositoryRead, repositoryInsightsController.languages);
repoRouter.get("/:id/insights/issues", optionalAuth, requireRepositoryRead, repositoryInsightsController.issues);
repoRouter.get("/:id/insights/pull-requests", optionalAuth, requireRepositoryRead, repositoryInsightsController.pullRequests);
repoRouter.get("/:id/insights/branches", optionalAuth, requireRepositoryRead, repositoryInsightsController.branches);
repoRouter.get("/:id/insights/activity", optionalAuth, requireRepositoryRead, repositoryInsightsController.activity);
repoRouter.get("/:id/insights/files", optionalAuth, requireRepositoryRead, repositoryInsightsController.files);
repoRouter.get("/:id/insights/actions", optionalAuth, requireRepositoryRead, repositoryInsightsController.actions);
repoRouter.post("/:id/pulls/:number/merge", requireAuth, requireRepositoryPermission(P.PULL_MERGE), pullRequestController.merge);
repoRouter.post("/:id/pulls/:number/close", requireAuth, requireRepositoryRead, pullRequestController.close);
repoRouter.post("/:id/pulls/:number/reopen", requireAuth, requireRepositoryRead, pullRequestController.reopen);
repoRouter.get("/:id/branches", requireRepositoryRead, listBranches);
repoRouter.post("/:id/branches", requireRepositoryWrite, createBranch);
repoRouter.get("/:id/branches/:branchName/status", optionalAuth, requireRepositoryRead, getBrowserStatus);
repoRouter.get("/:id/branches/:branchName/snapshot", requireRepositoryRead, getSnapshot);
repoRouter.get("/:id/branches/:branchName/history", requireRepositoryRead, getCommitHistory);
repoRouter.delete("/:id/branches/:branchName", requireRepositoryPermission(P.BRANCH_DELETE), deleteBranch);
repoRouter.get("/:id/history", requireRepositoryRead, getCommitHistory);
repoRouter.get("/:id/history/:branchName", requireRepositoryRead, getCommitHistory);
repoRouter.get("/:id/commit/:commitId/diff", requireRepositoryRead, getCommitDiff);
repoRouter.get("/:id/snapshot-file", requireRepositoryRead, getSnapshotFile);
repoRouter.get("/:id/snapshot", requireRepositoryRead, getSnapshot);
repoRouter.get("/:id/snapshot/:branchName", requireRepositoryRead, getSnapshot);

// Legacy history URL remains supported.
repoRouter.get("/history/:id", requireRepositoryRead, getCommitHistory);

repoRouter.get("/all", optionalAuth, repoController.getAllRepositories);
repoRouter.get("/name/:name", optionalAuth, repoController.fetchRepositoryByName);
repoRouter.get("/user/:userID", requireAuth, repoController.fetchRepositoriesForCurrentUser);
repoRouter.put("/update/:id", requireRepositoryPermission(P.REPOSITORY_UPDATE), repoController.updateRepositoryById);
repoRouter.delete("/delete/:id", requireRepositoryPermission(P.REPOSITORY_DELETE), repoController.deleteRepositoryById);
repoRouter.patch("/toggle/:id", requireRepositoryPermission(P.REPOSITORY_CHANGE_VISIBILITY), repoController.toggleVisibilityById);
// Express 4 wildcard routes preserve complete nested repository paths in req.params[0].
repoRouter.get("/preview/:id/*", requireRepositoryRead, previewFile);
repoRouter.get("/file/:id/*", requireRepositoryRead, getFile);
repoRouter.put("/file/:id/*", requireRepositoryPermission(P.FILE_RENAME, { branchResolver: (req) => req.body?.branch }), renameFile);
repoRouter.delete("/file/:id/*", requireRepositoryPermission(P.FILE_DELETE, { branchResolver: (req) => req.body?.branch }), deleteFile);
repoRouter.get("/:id", optionalAuth, requireRepositoryRead, repoController.fetchRepositoryById);

module.exports = repoRouter;
