const express = require("express");
const multer = require("multer");

const repoController = require("../controllers/repoController");
const { pushRepo } = require("../controllers/push");
const { addFiles } = require("../controllers/addController");
const { createCommit } = require("../controllers/commitController");
const repoRouter = express.Router();
const { getFile } = require("../controllers/fileController");
const { pullRepo } = require("../controllers/pull");

const upload = multer({
  dest: "uploads/",
});

// NEW ROUTE
repoRouter.post("/add/:id", upload.array("files"), addFiles);
repoRouter.post("/commit/:id", createCommit);
repoRouter.post("/create", repoController.createRepository);
repoRouter.get("/all", repoController.getAllRepositories);
repoRouter.get("/:id", repoController.fetchRepositoryById);
repoRouter.post("/push/:id", pushRepo);
repoRouter.get("/name/:name", repoController.fetchRepositoryByName);
repoRouter.get("/user/:userID", repoController.fetchRepositoriesForCurrentUser);
repoRouter.put("/update/:id", repoController.updateRepositoryById);
repoRouter.delete("/delete/:id", repoController.deleteRepositoryById);
repoRouter.patch("/toggle/:id", repoController.toggleVisibilityById);
repoRouter.get("/file/:id/:filename", getFile);
repoRouter.post("/pull/:id", pullRepo);

module.exports = repoRouter;
