const PullRequest = require("../models/pullRequestModel");
const { createNotification } = require("./notificationService");

const idOf = (value) => String(value?._id || value?.id || value || "");

async function notifyReviewersOfNewHead(repository, branch, headCommit, actor, {
  PullModel = PullRequest, notifyUser = createNotification,
} = {}) {
  if (!repository?._id || !branch || !headCommit) return [];
  if (PullModel === PullRequest && PullRequest.db.readyState !== 1) return [];
  try {
    const pulls = await PullModel.find({ repository: repository._id, compareBranch: branch, status: "open" })
      .select("_id number title author requestedReviewers reviews").lean();
    const results = [];
    for (const pullRequest of pulls) {
      const recipients = [...new Set((pullRequest.requestedReviewers || [])
        .filter((item) => item.status !== "removed").map((item) => idOf(item.user)))]
        .filter((recipient) => recipient && recipient !== idOf(actor));
      for (const recipient of recipients) {
        try {
          results.push(await notifyUser({
            recipient, actor, repository: repository._id, type: "review_required_again",
            title: `Re-review requested on PR #${pullRequest.number}`,
            message: `${pullRequest.title} has new commits`,
            url: `/repo/${repository._id}/pulls/${pullRequest.number}?tab=files`,
            eventKey: `rereview:${pullRequest._id}:${headCommit}:${recipient}`,
            metadata: { pullRequest: pullRequest._id, headCommit, branch },
          }));
        } catch (error) { console.error("Re-review notification failed:", error.message); }
      }
    }
    return results;
  } catch (error) {
    console.error(`Unable to find pull requests requiring re-review for repository ${idOf(repository)}:`, error.message);
    return [];
  }
}

module.exports = { notifyReviewersOfNewHead };
