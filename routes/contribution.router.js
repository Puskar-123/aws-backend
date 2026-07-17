const express = require("express");
const controller = require("../controllers/contributionController");
const { requireAuth } = require("../middleware/authMiddleware");
const router = express.Router();

router.use(requireAuth);
router.get("/profile", controller.getProfile);
router.put("/profile", controller.putProfile);
router.get("/history", controller.history);

module.exports = router;
