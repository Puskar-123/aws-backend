const User = require("../models/userModel");
const { requireAuthenticatedUser } = require("../utils/authUser");

function createSessionController({ UserModel = User } = {}) {
  async function session(req, res) {
    try {
      const user = await requireAuthenticatedUser(req, UserModel);
      return res.json({ user: { _id: user._id, username: user.username || "", name: user.name || "", avatarUrl: user.avatarUrl || "" } });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to validate session" });
    }
  }
  return { session };
}

module.exports = { createSessionController, ...createSessionController() };
