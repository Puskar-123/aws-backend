const { validateBranchName } = require("../utils/branches");
const { getRepositoryRole, hasRepositoryPermission } = require("./repositoryPermissionService");

const BOOLEAN_FIELDS = [
  "enabled", "requirePullRequest", "blockDirectCommits", "blockForcePush",
  "blockDeletion", "requireResolvedConversations", "dismissStaleApprovals",
  "allowOwnerBypass", "allowMaintainerBypass",
];
const idOf = (value) => String(value?._id || value?.id || value || "");

function protectionError(status, message, code, extras = {}) {
  return Object.assign(new Error(message), { status, code, ...extras });
}

function getBranchProtection(repository, branchName) {
  let normalized;
  try { normalized = validateBranchName(branchName); } catch { return null; }
  return (repository?.branchProtections || []).find((rule) => rule.enabled !== false && rule.branch === normalized) || null;
}

const isBranchProtected = (repository, branchName) => Boolean(getBranchProtection(repository, branchName));

function canBypassProtection(repository, userId, protection = null) {
  const role = getRepositoryRole(repository, userId);
  const rule = protection || null;
  return Boolean((role === "owner" && rule?.allowOwnerBypass)
    || (role === "maintainer" && rule?.allowMaintainerBypass));
}

function audit(repository, branch, action, userId, outcome, rule) {
  console.info("Branch protection audit", {
    repositoryId: idOf(repository), branch, action, actorId: idOf(userId), outcome, rule,
  });
}

function assertCanDirectWrite(repository, branchName, userId, action = "direct_write", { force = false } = {}) {
  const branch = validateBranchName(branchName || repository?.defaultBranch || "main");
  const protection = getBranchProtection(repository, branch);
  if (!protection) return { protected: false, canBypass: false };
  const blocked = Boolean(protection.requirePullRequest || protection.blockDirectCommits || (force && protection.blockForcePush));
  if (!blocked) return { protected: true, canBypass: false, protection };
  if (canBypassProtection(repository, userId, protection)) {
    audit(repository, branch, action, userId, "bypassed", force && protection.blockForcePush ? "blockForcePush" : (protection.requirePullRequest ? "requirePullRequest" : "blockDirectCommits"));
    return { protected: true, canBypass: true, protection };
  }
  audit(repository, branch, action, userId, "blocked", force && protection.blockForcePush ? "blockForcePush" : (protection.requirePullRequest ? "requirePullRequest" : "blockDirectCommits"));
  throw protectionError(403, `Direct changes to protected branch '${branch}' are not allowed.`, "BRANCH_PROTECTED", {
    branch, suggestedAction: "Create a new branch and open a pull request.",
  });
}

function assertCanDeleteBranch(repository, branchName, userId) {
  const branch = validateBranchName(branchName);
  const protection = getBranchProtection(repository, branch);
  if (protection?.blockDeletion) {
    audit(repository, branch, "delete_branch", userId, "blocked", "blockDeletion");
    throw protectionError(403, `Protected branch '${branch}' cannot be deleted.`, "BRANCH_PROTECTED", { branch });
  }
  return true;
}

function latestReviews(reviews = []) {
  const latest = new Map();
  for (const review of reviews) latest.set(idOf(review.reviewer), review);
  return [...latest.values()];
}

function evaluateMergeProtection(repository, pullRequest, currentHead) {
  const protection = getBranchProtection(repository, pullRequest.baseBranch);
  if (!protection) return { protected: false, requirementsPassed: true, requiredApprovals: 0, currentApprovals: 0 };
  const authorId = idOf(pullRequest.author);
  const reviews = latestReviews(pullRequest.reviews);
  const effective = reviews.filter((review) => idOf(review.reviewer) !== authorId
    && hasRepositoryPermission(repository, idOf(review.reviewer), "review_pr"));
  const changesRequested = effective.some((review) => review.decision === "changes_requested");
  const approvals = effective.filter((review) => review.decision === "approved"
    && (!protection.dismissStaleApprovals || !review.commitHead || String(review.commitHead) === String(currentHead || "")));
  return {
    protected: true,
    requirementsPassed: !changesRequested && approvals.length >= protection.requiredApprovals,
    requiredApprovals: protection.requiredApprovals,
    currentApprovals: approvals.length,
    changesRequested,
    dismissStaleApprovals: Boolean(protection.dismissStaleApprovals),
    resolvedConversationsApplicable: false,
    requireResolvedConversations: Boolean(protection.requireResolvedConversations),
  };
}

function assertCanMergePullRequest(repository, pullRequest, currentHead) {
  const summary = evaluateMergeProtection(repository, pullRequest, currentHead);
  if (!summary.protected) return summary;
  if (summary.changesRequested) throw protectionError(409, "Pull request cannot be merged while changes are requested.", "CHANGES_REQUESTED", summary);
  if (summary.currentApprovals < summary.requiredApprovals) {
    throw protectionError(409, `Pull request requires ${summary.requiredApprovals} approval${summary.requiredApprovals === 1 ? "" : "s"} before merging.`, "APPROVAL_REQUIRED", {
      required: summary.requiredApprovals, current: summary.currentApprovals,
    });
  }
  return summary;
}

function getProtectionSummary(repository, branchName, userId) {
  const protection = getBranchProtection(repository, branchName);
  if (!protection) return { protected: false, canBypass: false };
  return {
    protected: true,
    branch: protection.branch,
    canBypass: canBypassProtection(repository, userId, protection),
    requirePullRequest: Boolean(protection.requirePullRequest),
    requiredApprovals: protection.requiredApprovals,
    blockDirectCommits: Boolean(protection.blockDirectCommits),
    blockForcePush: Boolean(protection.blockForcePush),
    blockDeletion: Boolean(protection.blockDeletion),
    dismissStaleApprovals: Boolean(protection.dismissStaleApprovals),
    requireResolvedConversations: Boolean(protection.requireResolvedConversations),
    allowOwnerBypass: Boolean(protection.allowOwnerBypass),
    allowMaintainerBypass: Boolean(protection.allowMaintainerBypass),
  };
}

module.exports = {
  BOOLEAN_FIELDS, protectionError, getBranchProtection, isBranchProtected,
  canBypassProtection, assertCanDirectWrite, assertCanDeleteBranch,
  evaluateMergeProtection, assertCanMergePullRequest, getProtectionSummary, latestReviews,
};
