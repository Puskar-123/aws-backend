const express = require("express");
const userController = require("../controllers/userController");
const profileController = require("../controllers/profileController");
const { optionalAuth, requireAuth } = require("../middleware/authMiddleware");
const sessionController = require("../controllers/sessionController");
const { noStore } = require("../middleware/noStore");

const userRouter = express.Router();

// ✅ USERS
userRouter.get("/allUsers", userController.getAllUsers);

// ✅ AUTH
userRouter.post("/signup", userController.signup);
userRouter.post("/login", userController.login);
userRouter.get("/session", noStore, requireAuth, sessionController.session);

// ✅ PROFILE
userRouter.get("/profile/:id", noStore, optionalAuth, profileController.getProfile);
userRouter.put("/profile/:id", noStore, requireAuth, profileController.updateProfile);
userRouter.put("/update/:id", noStore, requireAuth, userController.updateUserProfile);
userRouter.delete("/delete/:id", noStore, requireAuth, userController.deleteUserProfile);

// 🔥 FOLLOW / UNFOLLOW
userRouter.post("/follow", noStore, requireAuth, userController.followUser);

// 🔥 CHECK FOLLOW STATUS
userRouter.get("/is-following/:followerId/:followingId", userController.isFollowing);

module.exports = userRouter;


// const express = require("express");
// const userController = require("../controllers/userController");

// const userRouter = express.Router();

// userRouter.get("/allUsers", userController.getAllUsers);
// userRouter.post("/user/signup", userController.signup);
// userRouter.post("/user/login", userController.login);
// userRouter.get("/userProfile/:id", userController.getUserProfile);
// userRouter.put("/updateProfile/:id", userController.updateUserProfile);
// userRouter.delete("/deleteProfile/:id", userController.deleteUserProfile);

// module.exports = userRouter;
