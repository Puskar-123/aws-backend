const express = require("express");
const controller = require("../controllers/notificationController");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(requireAuth);
router.get("/", controller.list);
router.get("/unread-count", controller.unreadCount);
router.patch("/read-all", controller.readAll);
router.delete("/read", controller.removeRead);
router.patch("/:id/read", controller.readOne);
router.delete("/:id", controller.removeOne);

module.exports = router;
