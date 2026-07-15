const buckets = new Map();
function workflowRateLimit({ windowMs = 60_000, max = 30 } = {}) {
  return (req, res, next) => {
    const key = `${req.user?.id || req.ip || "anonymous"}:${req.params.id || "global"}`;
    const now = Date.now(); const current = buckets.get(key);
    if (!current || current.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
    else if (++current.count > max) return res.status(429).json({ error: "Too many workflow requests", code: "CONCURRENCY_LIMIT_EXCEEDED" });
    return next();
  };
}
module.exports = { buckets, workflowRateLimit };
