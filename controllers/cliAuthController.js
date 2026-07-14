const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const { requireAuthenticatedUser } = require("../utils/authUser");

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function rateKey(req) { return String(req.ip || req.socket?.remoteAddress || "unknown"); }
function checkRate(req) {
  const key = rateKey(req); const now = Date.now();
  const current = attempts.get(key);
  if (!current || now - current.startedAt > WINDOW_MS) {
    attempts.set(key, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > MAX_ATTEMPTS) {
    const error = new Error("Too many login attempts. Try again later.");
    error.status = 429; error.code = "RATE_LIMITED";
    throw error;
  }
}

function createCliAuthController({ UserModel = User, compare = bcrypt.compare, sign = jwt.sign } = {}) {
  async function login(req, res) {
    try {
      checkRate(req);
      const identifier = String(req.body?.usernameOrEmail || req.body?.email || "").trim();
      const password = String(req.body?.password || "");
      if (!identifier || !password) return res.status(400).json({ error: "Username or email and password are required", code: "INVALID_CREDENTIALS" });
      const user = await UserModel.findOne({ $or: [{ username: identifier }, { email: identifier.toLowerCase() }] }).select("_id username name email password");
      if (!user || !user.password || !await compare(password, user.password)) return res.status(401).json({ error: "Invalid credentials", code: "INVALID_CREDENTIALS" });
      attempts.delete(rateKey(req));
      const expiresInSeconds = 60 * 60;
      const accessToken = sign({ id: user._id, purpose: "cli" }, process.env.JWT_SECRET_KEY, { expiresIn: expiresInSeconds });
      return res.json({
        accessToken,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
        user: { _id: user._id, username: user.username || "", name: user.name || "" },
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to sign in", ...(error.code ? { code: error.code } : {}) });
    }
  }

  async function session(req, res) {
    try {
      const user = await requireAuthenticatedUser(req, UserModel);
      return res.json({ user: { _id: user._id, username: user.username || "", name: user.name || "", avatarUrl: user.avatarUrl || "" } });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to validate CLI session", code: error.status === 401 ? "TOKEN_EXPIRED" : undefined });
    }
  }

  function logout(_req, res) { return res.json({ message: "Logged out successfully" }); }
  return { login, logout, session };
}

module.exports = { createCliAuthController, ...createCliAuthController() };
