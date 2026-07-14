const { hasRepositoryPermission } = require("./repositoryPermissionService");

const idOf = (value) => String(value?._id || value?.id || value || "");

function getLatestReviewsByReviewer(reviews = []) {
  const latest = new Map();
  for (const review of reviews) latest.set(idOf(review.reviewer), review);
  return [...latest.values()];
}

function threadIsOutdated(thread, currentHeadCommit) {
  return Boolean(thread.outdated || !currentHeadCommit || String(thread.commitHash || "") !== String(currentHeadCommit));
}

function getEffectiveReviewSummary(repository, pullRequest, currentHeadCommit, options = {}) {
  const dismissStaleApprovals = Boolean(options.dismissStaleApprovals);
  const authorId = idOf(pullRequest.author);
  const latest = getLatestReviewsByReviewer(pullRequest.reviews || []);
  const decorated = latest.map((review) => {
    const reviewerId = idOf(review.reviewer);
    const eligible = reviewerId !== authorId && hasRepositoryPermission(repository, reviewerId, "review_pr");
    const stale = review.decision === "approved" && Boolean(review.commitHead)
      && String(review.commitHead) !== String(currentHeadCommit || "");
    const value = review.toObject ? review.toObject() : { ...review };
    return { ...value, stale, eligible };
  });
  const effective = decorated.filter((review) => review.eligible);
  const approvals = effective.filter((review) => review.decision === "approved"
    && (!dismissStaleApprovals || !review.stale));
  const changesRequested = effective.filter((review) => review.decision === "changes_requested");
  const staleApprovals = effective.filter((review) => review.decision === "approved" && review.stale);
  return {
    approvals: approvals.length,
    changesRequested: changesRequested.length,
    staleApprovals: staleApprovals.length,
    blocking: changesRequested.length > 0,
    latestByReviewer: decorated,
    changesRequestedBy: changesRequested.map((review) => review.reviewer),
  };
}

function getUnresolvedThreadCount(pullRequest, currentHeadCommit) {
  return (pullRequest.reviewThreads || []).filter((thread) => !thread.resolved
    && !threadIsOutdated(thread, currentHeadCommit)).length;
}

function getRequestedReviewerStatus(pullRequest, repository = null) {
  const latest = new Map(getLatestReviewsByReviewer(pullRequest.reviews || []).map((review) => [idOf(review.reviewer), review]));
  return (pullRequest.requestedReviewers || []).filter((request) => request.status !== "removed").map((request) => {
    const value = request.toObject ? request.toObject() : { ...request };
    const review = latest.get(idOf(request.user));
    const stillEligible = !repository || hasRepositoryPermission(repository, idOf(request.user), "review_pr");
    return { ...value, status: stillEligible ? (review ? review.decision : "requested") : "removed" };
  });
}

function getReviewMergeStatus(repository, pullRequest, currentHeadCommit, protection = null) {
  const requiredApprovals = Number(protection?.requiredApprovals || 0);
  const dismissStaleApprovals = Boolean(protection?.dismissStaleApprovals);
  const requireResolvedConversations = Boolean(protection?.requireResolvedConversations);
  const summary = getEffectiveReviewSummary(repository, pullRequest, currentHeadCommit, { dismissStaleApprovals });
  const unresolvedConversations = getUnresolvedThreadCount(pullRequest, currentHeadCommit);
  const checks = [
    { name: "Required approvals", passed: summary.approvals >= requiredApprovals, message: `${summary.approvals} of ${requiredApprovals} approvals` },
    { name: "Changes requested", passed: !summary.blocking, message: summary.blocking ? `${summary.changesRequested} reviewer${summary.changesRequested === 1 ? " has" : "s have"} requested changes` : "No changes requested" },
  ];
  if (requireResolvedConversations) checks.push({
    name: "Review conversations",
    passed: unresolvedConversations === 0,
    message: `${unresolvedConversations} unresolved conversation${unresolvedConversations === 1 ? "" : "s"}`,
  });
  return {
    mergeable: checks.every((check) => check.passed),
    requiredApprovals,
    validApprovals: summary.approvals,
    changesRequested: summary.blocking,
    changesRequestedCount: summary.changesRequested,
    unresolvedConversations,
    staleApprovals: summary.staleApprovals,
    latestByReviewer: summary.latestByReviewer,
    checks,
  };
}

module.exports = {
  getLatestReviewsByReviewer,
  getEffectiveReviewSummary,
  getUnresolvedThreadCount,
  getRequestedReviewerStatus,
  getReviewMergeStatus,
  threadIsOutdated,
};
