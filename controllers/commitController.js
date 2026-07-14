const { commitRepo } = require("./commit");
const { safeNotifyRepositoryWatchers } = require("../services/notificationService");
const { notifyReviewersOfNewHead } = require("../services/reviewNotificationService");

async function createCommit(req, res) {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Commit message is required",
      });
    }

    const commit = await commitRepo(id, message, { ...req.body, authenticatedUserId: req.user?.id });
    await safeNotifyRepositoryWatchers(req.repository, {
      actor: req.user?.id,
      type: "commit",
      title: `New commit in ${req.repository.name}`,
      message,
      url: `/repo/${id}?branch=${encodeURIComponent(commit.branch)}`,
      eventKey: `commit:${id}:${commit.hash}`,
      metadata: { commit: commit.hash, branch: commit.branch },
    });
    await notifyReviewersOfNewHead(req.repository, commit.branch, commit.hash, req.user?.id);

    res.status(200).json({
      message: "Commit created successfully!",
      commit,
    });
  } catch (err) {
    console.error(err);
    const status = err.message === "Invalid repository ID"
      ? 400
      : (err.message === "Repository not found" ? 404 : (err.status || 500));
    res.status(status).json({ error: status === 500 ? "Commit failed" : err.message, ...(err.code ? { code: err.code, branch: err.branch, suggestedAction: err.suggestedAction } : {}) });
  }
}

module.exports = {
  createCommit,
};
