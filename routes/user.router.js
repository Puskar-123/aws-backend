const express = require("express");
const userController = require("../controllers/userController");

const userRouter = express.Router();

// ✅ USERS
userRouter.get("/allUsers", userController.getAllUsers);

// ✅ AUTH
userRouter.post("/signup", userController.signup);
userRouter.post("/login", userController.login);

// ✅ PROFILE
userRouter.get("/profile/:id", userController.getUserProfile);
userRouter.put("/update/:id", userController.updateUserProfile);
userRouter.delete("/delete/:id", userController.deleteUserProfile);

// 🔥 FOLLOW / UNFOLLOW
userRouter.post("/follow", userController.followUser);

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
