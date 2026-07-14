const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");

const issueRouter = express.Router();

// Legacy endpoints never enforced repository authorization and several could
// not identify a repository. Keep an explicit compatibility response instead
// of leaving an insecure write surface available.
issueRouter.use(requireAuth);
issueRouter.all("*", (_req, res) => res.status(410).json({
  error: "This legacy issue endpoint has moved to /repo/:id/issues",
}));

module.exports = issueRouter;
