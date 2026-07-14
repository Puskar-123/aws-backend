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
const { optionalAuth, requireAuth } = require("../middleware/authMiddleware");
const { requireRepositoryRead, requireRepositoryWrite } = require("../utils/repositoryAccess");

const repoRouter = express.Router();
const upload = multer({ dest: "uploads/" });

// Existing write workflows.
repoRouter.post("/add/:id", requireRepositoryWrite, upload.array("files"), addFiles);
repoRouter.post("/commit/:id", requireRepositoryWrite, createCommit);
repoRouter.post("/push/:id", requireRepositoryWrite, pushRepo);
repoRouter.post("/pull/:id", requireRepositoryRead, pullRepo);
repoRouter.post("/create", repoController.createRepository);

// Branch, history, and clone/snapshot APIs. Keep these before /:id.
repoRouter.get("/:id/compare", compareBranches);
repoRouter.post("/:id/pulls", requireAuth, requireRepositoryRead, pullRequestController.create);
repoRouter.get("/:id/pulls", optionalAuth, requireRepositoryRead, pullRequestController.list);
repoRouter.get("/:id/pulls/:number", optionalAuth, requireRepositoryRead, pullRequestController.details);
repoRouter.patch("/:id/pulls/:number", requireAuth, requireRepositoryRead, pullRequestController.update);
repoRouter.post("/:id/pulls/:number/comments", requireAuth, requireRepositoryRead, pullRequestController.comment);
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

repoRouter.get("/all", repoController.getAllRepositories);
repoRouter.get("/name/:name", repoController.fetchRepositoryByName);
repoRouter.get("/user/:userID", repoController.fetchRepositoriesForCurrentUser);
repoRouter.put("/update/:id", repoController.updateRepositoryById);
repoRouter.delete("/delete/:id", requireRepositoryWrite, repoController.deleteRepositoryById);
repoRouter.patch("/toggle/:id", repoController.toggleVisibilityById);
// Express 4 wildcard routes preserve complete nested repository paths in req.params[0].
repoRouter.get("/preview/:id/*", previewFile);
repoRouter.get("/file/:id/*", getFile);
repoRouter.put("/file/:id/*", requireRepositoryWrite, renameFile);
repoRouter.delete("/file/:id/*", requireRepositoryWrite, deleteFile);
repoRouter.get("/:id", repoController.fetchRepositoryById);

module.exports = repoRouter;
