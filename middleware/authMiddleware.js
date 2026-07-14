const jwt = require("jsonwebtoken");

function readAuthenticatedUser(req) {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  try {
    const payload = jwt.verify(authorization.slice(7), process.env.JWT_SECRET_KEY);
    return payload?.id ? { id: String(payload.id) } : null;
  } catch {
    return null;
  }
}

function optionalAuth(req, _res, next) {
  req.user = readAuthenticatedUser(req);
  next();
}

function requireAuth(req, res, next) {
  req.user = readAuthenticatedUser(req);
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  return next();
}

module.exports = { optionalAuth, readAuthenticatedUser, requireAuth };
