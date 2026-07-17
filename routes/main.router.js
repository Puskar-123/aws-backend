const express = require("express");
const userRouter = require("./user.router");
const repoRouter = require("./repo.router");
const issueRouter = require("./issue.router");
const notificationRouter = require("./notification.router");
const invitationRouter = require("./invitation.router");
const chatRouter = require("./chat.router");
const contributionRouter = require("./contribution.router");
const { noStore } = require("../middleware/noStore");
const publicDiscoveryController = require("../controllers/publicDiscoveryController");

const mainRouter = express.Router();

// ✅ FIX HERE 👇
mainRouter.use("/user", userRouter);
mainRouter.use("/repo", noStore, repoRouter);
mainRouter.use("/issue", issueRouter);
mainRouter.use("/notifications", noStore, notificationRouter);
mainRouter.use("/invitations", noStore, invitationRouter);
mainRouter.use("/chat", noStore, chatRouter);
mainRouter.use("/contributions", noStore, contributionRouter);
mainRouter.get("/search", publicDiscoveryController.search);
mainRouter.get("/users/:username/repositories", publicDiscoveryController.userRepositories);
mainRouter.get("/users/:username", publicDiscoveryController.publicProfile);

mainRouter.get("/", (req, res) => {
  res.send("Welcome!");
});

module.exports = mainRouter;

// const express = require("express");
// const userRouter = require("./user.router");
// const repoRouter = require("./repo.router");
// const issueRouter = require("./issue.router");

// const mainRouter = express.Router();

// mainRouter.use(userRouter);
// mainRouter.use(repoRouter);
// mainRouter.use(issueRouter);

// mainRouter.get("/", (req, res) => {
//   res.send("Welcome!");
// });

// module.exports = mainRouter;
