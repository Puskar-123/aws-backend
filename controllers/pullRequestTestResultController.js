const PullRequest = require("../models/pullRequestModel");
const PullRequestTestResult = require("../models/pullRequestTestResultModel");

const cleanSummary = (value) => String(value || "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
const sendError = (res, error) => res.status(error.status || 500).json({ error: error.code || "TEST_RESULT_ERROR", message: error.status ? error.message : "Unable to manage test results" });

async function findPull(req) {
  const pull = await PullRequest.findOne({ repository: req.repository._id, number: Number(req.params.number) });
  if (!pull) throw Object.assign(new Error("Pull request not found"), { status: 404, code: "PULL_REQUEST_NOT_FOUND" });
  return pull;
}

async function create(req, res) {
  try {
    const status = String(req.body?.status || ""); const summary = cleanSummary(req.body?.summary);
    if (!['passed', 'failed'].includes(status)) return res.status(400).json({ error: "INVALID_TEST_RESULT", message: "Status must be passed or failed" });
    if (!summary || summary.length > 1000) return res.status(400).json({ error: "INVALID_TEST_RESULT", message: "Summary must contain 1 to 1000 characters" });
    const pull = await findPull(req);
    const result = await PullRequestTestResult.create({ repository: req.repository._id, pullRequest: pull._id,
      tester: req.user.id, status, summary });
    await result.populate("tester", "_id username name avatarUrl");
    return res.status(201).json({ message: "Test result recorded", result });
  } catch (error) { return sendError(res, error); }
}

async function list(req, res) {
  try {
    const pull = await findPull(req);
    const results = await PullRequestTestResult.find({ repository: req.repository._id, pullRequest: pull._id })
      .sort({ createdAt: -1 }).populate("tester", "_id username name avatarUrl").lean();
    return res.json({ results });
  } catch (error) { return sendError(res, error); }
}

module.exports = { create, list };
