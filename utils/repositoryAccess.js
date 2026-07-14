const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");

function getAuthenticatedUserId(req) {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  try {
    return String(jwt.verify(authorization.slice(7), process.env.JWT_SECRET_KEY).id || "");
  } catch {
    return null;
  }
}

async function getAccessibleRepository(req, id, { write = false, populateOwner = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error("Invalid repository ID");
    error.status = 400;
    throw error;
  }

  let query = Repository.findById(id);
  if (populateOwner) query = query.populate("owner", "username email");
  const repository = await query;
  if (!repository) {
    const error = new Error("Repository not found");
    error.status = 404;
    throw error;
  }

  const userId = getAuthenticatedUserId(req);
  const ownerId = String(repository.owner?._id || repository.owner || "");
  const isOwner = Boolean(userId && userId === ownerId);
  if ((write && !isOwner) || (repository.visibility === "private" && !isOwner)) {
    const error = new Error(userId ? "You do not have access to this repository" : "Authentication required");
    error.status = userId ? 403 : 401;
    throw error;
  }
  return repository;
}

function sendAccessError(res, error) {
  return res.status(error.status || 500).json({ error: error.status ? error.message : "Internal Server Error" });
}

function repositoryAccessMiddleware(options) {
  return async (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      if (userId && !req.user) req.user = { id: userId };
      req.repository = await getAccessibleRepository(req, req.params.id, options);
      next();
    } catch (error) {
      sendAccessError(res, error);
    }
  };
}

const requireRepositoryRead = repositoryAccessMiddleware({ write: false });
const requireRepositoryWrite = repositoryAccessMiddleware({ write: true });

module.exports = {
  getAccessibleRepository,
  sendAccessError,
  getAuthenticatedUserId,
  requireRepositoryRead,
  requireRepositoryWrite,
};
