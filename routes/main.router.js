const express = require("express");
const userRouter = require("./user.router");
const repoRouter = require("./repo.router");
const issueRouter = require("./issue.router");
const notificationRouter = require("./notification.router");
const { noStore } = require("../middleware/noStore");

const mainRouter = express.Router();

// ✅ FIX HERE 👇
mainRouter.use("/user", userRouter);
mainRouter.use("/repo", noStore, repoRouter);
mainRouter.use("/issue", issueRouter);
mainRouter.use("/notifications", noStore, notificationRouter);

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
