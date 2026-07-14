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
const { previewFile } = require("../controllers/previewController");
const { deleteFile, renameFile } = require("../controllers/fileManageController");
const { listBranches, createBranch, deleteBranch } = require("../controllers/branchController");
const { getSnapshot, getSnapshotFile } = require("../controllers/snapshotController");
const { compareBranches } = require("../controllers/compareController");
const pullRequestController = require("../controllers/pullRequestController");
const issueController = require("../controllers/issueController");
const socialController = require("../controllers/repositorySocialController");
const fileEditController = require("../controllers/fileEditController");
const { optionalAuth, requireAuth } = require("../middleware/authMiddleware");
const { requireRepositoryRead, requireRepositoryWrite } = require("../utils/repositoryAccess");

const repoRouter = express.Router();
const upload = multer({ dest: "uploads/" });

// Existing write workflows.
repoRouter.post("/add/:id", requireRepositoryWrite, upload.array("files"), addFiles);
repoRouter.post("/commit/:id", requireRepositoryWrite, createCommit);
repoRouter.post("/push/:id", requireRepositoryWrite, pushRepo);
repoRouter.post("/pull/:id", requireRepositoryWrite, pullRepo);
repoRouter.post("/create", requireAuth, repoController.createRepository);
repoRouter.post("/:id/star", requireAuth, requireRepositoryRead, socialController.star);
repoRouter.delete("/:id/star", requireAuth, requireRepositoryRead, socialController.unstar);
repoRouter.get("/:id/star-status", optionalAuth, requireRepositoryRead, socialController.status);
repoRouter.post("/:id/watch", requireAuth, requireRepositoryRead, socialController.watch);
repoRouter.delete("/:id/watch", requireAuth, requireRepositoryRead, socialController.unwatch);
repoRouter.get("/:id/watch-status", optionalAuth, requireRepositoryRead, socialController.status);
repoRouter.post("/:id/fork", requireAuth, requireRepositoryRead, socialController.fork);
repoRouter.get("/:id/file-editor", requireRepositoryWrite, fileEditController.read);
repoRouter.put("/:id/file-editor", requireRepositoryWrite, fileEditController.update);

// Branch, history, and clone/snapshot APIs. Keep these before /:id.
repoRouter.get("/:id/compare", compareBranches);
repoRouter.post("/:id/issues", requireAuth, requireRepositoryRead, issueController.create);
repoRouter.get("/:id/issues", optionalAuth, requireRepositoryRead, issueController.list);
repoRouter.get("/:id/issues/:number", optionalAuth, requireRepositoryRead, issueController.details);
repoRouter.patch("/:id/issues/:number", requireAuth, requireRepositoryRead, issueController.update);
repoRouter.post("/:id/issues/:number/comments", requireAuth, requireRepositoryRead, issueController.comment);
repoRouter.post("/:id/issues/:number/close", requireAuth, requireRepositoryRead, issueController.close);
repoRouter.post("/:id/issues/:number/reopen", requireAuth, requireRepositoryRead, issueController.reopen);
repoRouter.post("/:id/issues/:number/labels", requireAuth, requireRepositoryRead, issueController.addLabel);
repoRouter.delete("/:id/issues/:number/labels/:labelName", requireAuth, requireRepositoryRead, issueController.removeLabel);
repoRouter.post("/:id/issues/:number/assignees", requireAuth, requireRepositoryRead, issueController.addAssignee);
repoRouter.delete("/:id/issues/:number/assignees/:userId", requireAuth, requireRepositoryRead, issueController.removeAssignee);
repoRouter.post("/:id/issues/:number/link-pr", requireAuth, requireRepositoryRead, issueController.linkPullRequest);
repoRouter.post("/:id/pulls", requireAuth, requireRepositoryRead, pullRequestController.create);
repoRouter.get("/:id/pulls", optionalAuth, requireRepositoryRead, pullRequestController.list);
repoRouter.get("/:id/pulls/:number", optionalAuth, requireRepositoryRead, pullRequestController.details);
repoRouter.patch("/:id/pulls/:number", requireAuth, requireRepositoryRead, pullRequestController.update);
repoRouter.post("/:id/pulls/:number/comments", requireAuth, requireRepositoryRead, pullRequestController.comment);
repoRouter.get("/:id/pulls/:number/reviews", optionalAuth, requireRepositoryRead, pullRequestController.listReviews);
repoRouter.post("/:id/pulls/:number/reviews", requireAuth, requireRepositoryRead, pullRequestController.review);
repoRouter.post("/:id/pulls/:number/merge", requireAuth, requireRepositoryWrite, pullRequestController.merge);
repoRouter.post("/:id/pulls/:number/close", requireAuth, requireRepositoryRead, pullRequestController.close);
repoRouter.post("/:id/pulls/:number/reopen", requireAuth, requireRepositoryRead, pullRequestController.reopen);
repoRouter.get("/:id/branches", listBranches);
repoRouter.post("/:id/branches", requireRepositoryWrite, createBranch);
repoRouter.get("/:id/branches/:branchName/snapshot", getSnapshot);
repoRouter.get("/:id/branches/:branchName/history", getCommitHistory);
repoRouter.delete("/:id/branches/:branchName", deleteBranch);
repoRouter.get("/:id/history", getCommitHistory);
repoRouter.get("/:id/history/:branchName", getCommitHistory);
repoRouter.get("/:id/commit/:commitId/diff", getCommitDiff);
repoRouter.get("/:id/snapshot-file", getSnapshotFile);
repoRouter.get("/:id/snapshot", getSnapshot);
repoRouter.get("/:id/snapshot/:branchName", getSnapshot);

// Legacy history URL remains supported.
repoRouter.get("/history/:id", getCommitHistory);

repoRouter.get("/all", optionalAuth, repoController.getAllRepositories);
repoRouter.get("/name/:name", repoController.fetchRepositoryByName);
repoRouter.get("/user/:userID", requireAuth, repoController.fetchRepositoriesForCurrentUser);
repoRouter.put("/update/:id", requireRepositoryWrite, repoController.updateRepositoryById);
repoRouter.delete("/delete/:id", requireRepositoryWrite, repoController.deleteRepositoryById);
repoRouter.patch("/toggle/:id", requireRepositoryWrite, repoController.toggleVisibilityById);
// Express 4 wildcard routes preserve complete nested repository paths in req.params[0].
repoRouter.get("/preview/:id/*", previewFile);
repoRouter.get("/file/:id/*", getFile);
repoRouter.put("/file/:id/*", requireRepositoryWrite, renameFile);
repoRouter.delete("/file/:id/*", requireRepositoryWrite, deleteFile);
repoRouter.get("/:id", optionalAuth, requireRepositoryRead, repoController.fetchRepositoryById);

module.exports = repoRouter;
