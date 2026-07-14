const { ObjectId } = require("mongodb");
const Repository = require("../models/repoModel");
const { connectClient, getCollection } = require("./userController");
const {
  buildProfileResponse,
  safeUser,
  validateProfileUpdate,
} = require("../utils/profile");

const isValidId = (id) => ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);

function createProfileController({
  connect = connectClient,
  users = getCollection,
  findRepositories = (ownerId) => Repository.find({ owner: ownerId }).lean(),
  findStarredRepositories = (profileId, viewerId) => Repository.find({
    stars: profileId,
    ...(viewerId ? { $or: [{ visibility: { $ne: "private" } }, { owner: viewerId }] } : { visibility: { $ne: "private" } }),
  }).populate("owner", "username").lean(),
} = {}) {
  const getProfile = async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ error: "Invalid user ID" });
    try {
      await connect();
      const user = await users().findOne({ _id: new ObjectId(id) });
      if (!user) return res.status(404).json({ error: "User not found" });
      const isOwner = String(req.user?.id || "") === String(id);
      const repositories = await findRepositories(new ObjectId(id));
      const starredRepositories = await findStarredRepositories(new ObjectId(id), req.user?.id || null);
      return res.json(buildProfileResponse(user, repositories, { isOwner, starredRepositories }));
    } catch (error) {
      console.error("Profile read failed:", error.message);
      return res.status(500).json({ error: "Unable to load profile" });
    }
  };

  const updateProfile = async (req, res) => {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ error: "Invalid user ID" });
    if (String(req.user?.id || "") !== String(id)) {
      return res.status(403).json({ error: "You can only edit your own profile" });
    }
    try {
      const update = validateProfileUpdate(req.body);
      await connect();
      const result = await users().findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: update },
        { returnDocument: "after" },
      );
      const user = result?.value || result;
      if (!user) return res.status(404).json({ error: "User not found" });
      return res.json({ user: safeUser(user, { includeEmail: true }) });
    } catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      console.error("Profile update failed:", error.message);
      return res.status(500).json({ error: "Unable to update profile" });
    }
  };

  return { getProfile, updateProfile };
}

const profileController = createProfileController();

module.exports = { createProfileController, ...profileController };
