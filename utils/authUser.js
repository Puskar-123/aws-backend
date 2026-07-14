const mongoose = require("mongoose");

function authenticationError(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

function getAuthenticatedUserId(req) {
  const value = req.user?._id
    || req.user?.id
    || req.user?.userId
    || req.userId
    || req.auth?._id
    || req.auth?.id
    || req.auth?.userId
    || req.user?.user?._id
    || req.user?.user?.id;
  return value == null ? null : String(value);
}

async function requireAuthenticatedUser(req, UserModel) {
  const id = getAuthenticatedUserId(req);
  if (!id) throw authenticationError("Authentication required");
  if (!mongoose.Types.ObjectId.isValid(id)) throw authenticationError("Invalid authenticated user");
  const user = await UserModel.findById(id).select("_id username name avatarUrl");
  if (!user) throw authenticationError("Authenticated user no longer exists");
  return user;
}

module.exports = { getAuthenticatedUserId, requireAuthenticatedUser };
