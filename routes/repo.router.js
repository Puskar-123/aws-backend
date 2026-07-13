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
repoRouter.get("/:id/branches", listBranches);
repoRouter.post("/:id/branches", createBranch);
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
repoRouter.delete("/delete/:id", repoController.deleteRepositoryById);
repoRouter.patch("/toggle/:id", repoController.toggleVisibilityById);
// Express 4 wildcard routes preserve complete nested repository paths in req.params[0].
repoRouter.get("/preview/:id/*", previewFile);
repoRouter.get("/file/:id/*", getFile);
repoRouter.put("/file/:id/*", requireRepositoryWrite, renameFile);
repoRouter.delete("/file/:id/*", requireRepositoryWrite, deleteFile);
repoRouter.get("/:id", repoController.fetchRepositoryById);

module.exports = repoRouter;
