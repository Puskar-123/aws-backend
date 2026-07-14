const express = require("express");
const controller = require("../controllers/repositoryCollaboratorController");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(requireAuth);
router.get("/", controller.listReceived);
router.patch("/:id/accept", controller.accept);
router.patch("/:id/decline", controller.decline);

module.exports = router;
