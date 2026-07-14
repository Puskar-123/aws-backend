const PullRequest = require("../models/pullRequestModel");
const Repository = require("../models/repoModel");
const User = require("../models/userModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { compareRepository } = require("../services/compareService");
const { branchByName } = require("../services/branchService");
const {
  canEditPullRequest,
  cleanText,
  comparisonSnapshot,
  createMergeCommit,
  historicalComparison,
  httpError,
  idOf,
  legacyMergeComparison,
  reviewSummary,
  validPullNumber,
} = require("../services/pullRequestService");
const { validateBranchName } = require("../utils/branches");
const { getAuthenticatedUserId, requireAuthenticatedUser } = require("../utils/authUser");
const { safeNotifyRepositoryWatchers } = require("../services/notificationService");
const { hasRepositoryPermission } = require("../services/repositoryPermissionService");

const safeAuthorFields = "_id username name avatarUrl";

function sendError(res, error) {
  if (!error.status) console.error("Pull request operation failed:", error.message);
  const body = { error: error.status ? error.message : "Pull request operation failed" };
  if (error.conflicts) body.conflicts = error.conflicts;
  return res.status(error.status || 500).json(body);
}

function pullObject(document) {
  const value = document?.toObject ? document.toObject() : document;
  if (!value) return null;
  const safeIdentity = (identity) => identity && typeof identity === "object"
    ? { _id: identity._id || identity.id, username: identity.username || "", name: identity.name || "", avatarUrl: identity.avatarUrl || "" }
    : null;
  return {
    ...value,
    author: safeIdentity(value.author),
    mergedBy: safeIdentity(value.mergedBy),
    comments: (value.comments || []).map((comment) => ({ ...comment, author: safeIdentity(comment.author) })),
    reviews: (value.reviews || []).map((review) => ({ ...review, reviewer: safeIdentity(review.reviewer) })),
    commentCount: value.comments?.length || 0,
  };
}

function createPullRequestController({
  PullModel = PullRequest,
  RepoModel = Repository,
  UserModel = User,
  compare = compareRepository,
  storage = s3,
  bucket = S3_BUCKET,
  notify = safeNotifyRepositoryWatchers,
} = {}) {
  const compareLive = (repository, base, compareBranch) => compare(repository, base, compareBranch, { s3: storage, bucket });

  async function findPull(repositoryId, number, populate = true) {
    const query = PullModel.findOne({ repository: repositoryId, number: validPullNumber(number) });
    if (!populate) return query;
    return query.populate("author", safeAuthorFields)
      .populate("mergedBy", safeAuthorFields)
      .populate("comments.author", safeAuthorFields)
      .populate("reviews.reviewer", safeAuthorFields);
  }

  async function create(req, res) {
    try {
      const repository = req.repository;
      const authenticatedUser = await requireAuthenticatedUser(req, UserModel);
      const title = cleanText(req.body?.title, 200, "Title", true);
      const description = cleanText(req.body?.description, 10000, "Description");
      const baseBranch = validateBranchName(req.body?.baseBranch);
      const compareBranch = validateBranchName(req.body?.compareBranch);
      if (baseBranch === compareBranch) throw httpError(400, "Base and compare branches must be different");
      if (!branchByName(repository, baseBranch)) throw httpError(404, `Base branch '${baseBranch}' not found`);
      if (!branchByName(repository, compareBranch)) throw httpError(404, `Compare branch '${compareBranch}' not found`);
      const duplicate = await PullModel.findOne({ repository: repository._id, baseBranch, compareBranch, status: "open" });
      if (duplicate) throw httpError(409, `An open pull request already exists for these branches (#${duplicate.number})`);
      const comparison = await compareLive(repository, baseBranch, compareBranch);
      if (!comparison.summary.filesChanged) throw httpError(400, "The selected branches have no changes");
      const storedComparison = comparisonSnapshot(comparison);
      const counter = await RepoModel.findOneAndUpdate(
        { _id: repository._id },
        { $inc: { pullRequestCounter: 1 } },
        { new: true, projection: { pullRequestCounter: 1 } },
      );
      if (!counter) throw httpError(404, "Repository not found");
      const pullRequest = await PullModel.create({
        repository: repository._id,
        number: counter.pullRequestCounter,
        title,
        description,
        author: authenticatedUser._id,
        baseBranch,
        compareBranch,
        baseHeadAtCreation: branchByName(repository, baseBranch)?.head || null,
        compareHeadAtCreation: branchByName(repository, compareBranch)?.head || null,
        mergeBaseAtCreation: storedComparison.mergeBase,
        commitIds: storedComparison.commitIds,
        changedFilesSummary: storedComparison.summary,
        changedFilesSnapshot: storedComparison.files,
      });
      if (pullRequest.populate) await pullRequest.populate("author", safeAuthorFields);
      await notify(repository, {
        actor: authenticatedUser._id, type: "pull_request_opened",
        title: `New pull request in ${repository.name}`, message: `#${pullRequest.number}: ${title}`,
        url: `/repo/${repository._id}/pulls/${pullRequest.number}`,
        eventKey: `pr-open:${pullRequest._id || pullRequest.number}`,
        metadata: { pullRequest: pullRequest._id, number: pullRequest.number },
      });
      return res.status(201).json({ message: "Pull request created successfully", pullRequest: pullObject(pullRequest) });
    } catch (error) { return sendError(res, error); }
  }

  async function list(req, res) {
    try {
      const status = String(req.query?.status || "open").toLowerCase();
      if (!["open", "closed", "merged", "all"].includes(status)) throw httpError(400, "Invalid pull request status");
      const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 20));
      const filter = { repository: req.repository._id, ...(status === "all" ? {} : { status }) };
      const [documents, total] = await Promise.all([
        PullModel.find(filter).populate("author", safeAuthorFields).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        PullModel.countDocuments(filter),
      ]);
      return res.json({
        pullRequests: documents.map(pullObject),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (error) { return sendError(res, error); }
  }

  async function details(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      let comparison;
      let comparisonSource;
      let historicalUnavailable = false;
      if (pullRequest.status === "merged") {
        comparison = historicalComparison(req.repository, pullRequest, true)
          || legacyMergeComparison(req.repository, pullRequest);
        comparisonSource = comparison ? "merge_snapshot" : "unavailable";
        historicalUnavailable = !comparison;
      } else {
        try {
          comparison = await compareLive(req.repository, pullRequest.baseBranch, pullRequest.compareBranch);
          comparisonSource = "live";
        } catch (error) {
          comparison = historicalComparison(req.repository, pullRequest, false);
          if (!comparison) throw error;
          comparisonSource = "creation_snapshot";
        }
      }
      const hasChanges = comparison ? comparison.summary.filesChanged > 0 : false;
      const hasConflicts = Boolean(comparison?.summary?.hasConflicts);
      const currentCompareHead = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      const reviews = reviewSummary(pullRequest.reviews, currentCompareHead);
      const authenticatedUserId = getAuthenticatedUserId(req);
      return res.json({
        pullRequest: pullObject(pullRequest),
        comparison,
        comparisonSource,
        historicalUnavailable,
        reviewSummary: reviews,
        branchesChangedSinceCreation: {
          base: String(branchByName(req.repository, pullRequest.baseBranch)?.head || "") !== String(pullRequest.baseHeadAtCreation || ""),
          compare: String(branchByName(req.repository, pullRequest.compareBranch)?.head || "") !== String(pullRequest.compareHeadAtCreation || ""),
        },
        permissions: {
          canEdit: canEditPullRequest(pullRequest, req.repository, authenticatedUserId),
          canMerge: hasRepositoryPermission(req.repository, authenticatedUserId, "merge_pr"),
          canComment: Boolean(authenticatedUserId),
          canReviewDecision: hasRepositoryPermission(req.repository, authenticatedUserId, "review_pr"),
          isAuthor: Boolean(authenticatedUserId) && idOf(pullRequest.author) === authenticatedUserId,
        },
        mergeability: {
          canMerge: pullRequest.status === "open" && hasChanges && !hasConflicts && !reviews.blocking,
          hasConflicts,
          blockedByReviews: reviews.blocking,
          reason: pullRequest.status !== "open"
            ? `Pull request is ${pullRequest.status}`
            : (!hasChanges ? "Branches have no changes" : (hasConflicts ? "Pull request has merge conflicts" : (reviews.blocking ? "Merge blocked by requested changes" : null))),
        },
      });
    } catch (error) { return sendError(res, error); }
  }

  async function update(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const authenticatedUserId = getAuthenticatedUserId(req);
      if (!canEditPullRequest(pullRequest, req.repository, authenticatedUserId)) throw httpError(403, "You do not have permission to edit this pull request");
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "title")) pullRequest.title = cleanText(req.body.title, 200, "Title", true);
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "description")) pullRequest.description = cleanText(req.body.description, 10000, "Description");
      await pullRequest.save();
      return res.json({ message: "Pull request updated", pullRequest: pullObject(pullRequest) });
    } catch (error) { return sendError(res, error); }
  }

  async function comment(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const authenticatedUser = await requireAuthenticatedUser(req, UserModel);
      const body = cleanText(req.body?.body, 5000, "Comment", true);
      const now = new Date();
      pullRequest.comments.push({ author: authenticatedUser._id, body, createdAt: now, updatedAt: now });
      await pullRequest.save();
      if (pullRequest.populate) await pullRequest.populate("comments.author", safeAuthorFields);
      const created = pullObject(pullRequest).comments.at(-1);
      await notify(req.repository, {
        actor: authenticatedUser._id, type: "pull_request_commented",
        title: `New comment on PR #${pullRequest.number}`, message: body,
        url: `/repo/${req.repository._id}/pulls/${pullRequest.number}`,
        eventKey: `pr-comment:${pullRequest._id}:${created?._id || now.getTime()}`,
        metadata: { pullRequest: pullRequest._id, comment: created?._id },
      });
      return res.status(201).json({ message: "Comment added", comment: created });
    } catch (error) { return sendError(res, error); }
  }

  async function setClosed(req, res, reopening) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const authenticatedUserId = getAuthenticatedUserId(req);
      if (!canEditPullRequest(pullRequest, req.repository, authenticatedUserId)) throw httpError(403, "You do not have permission to update this pull request");
      if (reopening) {
        if (pullRequest.status === "merged") throw httpError(409, "A merged pull request cannot be reopened");
        if (pullRequest.status !== "closed") throw httpError(409, "Only a closed pull request can be reopened");
        pullRequest.status = "open";
        pullRequest.closedAt = null;
      } else {
        if (pullRequest.status !== "open") throw httpError(409, "Only an open pull request can be closed");
        pullRequest.status = "closed";
        pullRequest.closedAt = new Date();
      }
      await pullRequest.save();
      return res.json({ message: reopening ? "Pull request reopened" : "Pull request closed", pullRequest: pullObject(pullRequest) });
    } catch (error) { return sendError(res, error); }
  }

  const close = (req, res) => setClosed(req, res, false);
  const reopen = (req, res) => setClosed(req, res, true);

  async function merge(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const authenticatedUser = await requireAuthenticatedUser(req, UserModel);
      if (pullRequest.status !== "open") throw httpError(409, `Pull request is already ${pullRequest.status}`);
      const comparison = await compareLive(req.repository, pullRequest.baseBranch, pullRequest.compareBranch);
      if (!comparison.summary.filesChanged) throw httpError(409, "Pull request has no changes to merge");
      if (comparison.summary.hasConflicts) {
        throw httpError(409, "Pull request has merge conflicts", { conflicts: comparison.files.filter((file) => file.conflict) });
      }
      const currentCompareHead = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      const reviews = reviewSummary(pullRequest.reviews, currentCompareHead);
      if (reviews.blocking) throw httpError(409, "Merge blocked by requested changes");
      const finalComparison = comparisonSnapshot(comparison);
      const commit = createMergeCommit(req.repository, pullRequest, comparison, String(authenticatedUser._id));
      await req.repository.save();
      pullRequest.status = "merged";
      pullRequest.mergeCommit = commit.hash;
      pullRequest.mergedBy = authenticatedUser._id;
      pullRequest.mergedAt = commit.time;
      pullRequest.closedAt = null;
      pullRequest.finalBaseHead = finalComparison.baseHead;
      pullRequest.finalCompareHead = finalComparison.compareHead;
      pullRequest.finalMergeBase = finalComparison.mergeBase;
      pullRequest.finalCommitIds = finalComparison.commitIds;
      pullRequest.finalChangedFilesSummary = finalComparison.summary;
      pullRequest.finalChangedFilesSnapshot = finalComparison.files;
      await pullRequest.save();
      if (pullRequest.populate) await pullRequest.populate("mergedBy", safeAuthorFields);
      await notify(req.repository, {
        actor: authenticatedUser._id, type: "pull_request_merged",
        title: `PR #${pullRequest.number} was merged`, message: pullRequest.title,
        url: `/repo/${req.repository._id}/pulls/${pullRequest.number}`,
        eventKey: `pr-merge:${pullRequest._id}`,
        metadata: { pullRequest: pullRequest._id, commit: commit.hash },
      });
      return res.json({ message: "Pull request merged", pullRequest: pullObject(pullRequest), mergeCommit: commit.hash });
    } catch (error) { return sendError(res, error); }
  }

  async function listReviews(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const head = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      return res.json({ reviews: pullObject(pullRequest).reviews, reviewSummary: reviewSummary(pullRequest.reviews, head) });
    } catch (error) { return sendError(res, error); }
  }

  async function review(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const authenticatedUser = await requireAuthenticatedUser(req, UserModel);
      if (pullRequest.status !== "open") throw httpError(409, "Only an open pull request can be reviewed");
      const decision = String(req.body?.decision || "");
      if (!["approved", "changes_requested", "commented"].includes(decision)) throw httpError(400, "Invalid review decision");
      const body = cleanText(req.body?.body, 5000, "Review");
      if (["changes_requested", "commented"].includes(decision) && !body) throw httpError(400, "Review body is required for this decision");
      if (decision === "approved" && idOf(pullRequest.author) === String(authenticatedUser._id)) throw httpError(403, "You cannot approve your own pull request");
      if (["approved", "changes_requested"].includes(decision)
        && !hasRepositoryPermission(req.repository, authenticatedUser._id, "review_pr")) {
        throw httpError(403, "You do not have permission to submit this review decision");
      }
      const commitHead = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      const now = new Date();
      pullRequest.reviews.push({ reviewer: authenticatedUser._id, decision, body, commitHead, createdAt: now, updatedAt: now });
      await pullRequest.save();
      await pullRequest.populate("reviews.reviewer", safeAuthorFields);
      const created = pullRequest.reviews.at(-1);
      const reviewValue = created?.toObject ? created.toObject() : { ...created };
      await notify(req.repository, {
        actor: authenticatedUser._id, type: "pull_request_reviewed",
        title: `PR #${pullRequest.number} was reviewed`, message: decision.replaceAll("_", " "),
        url: `/repo/${req.repository._id}/pulls/${pullRequest.number}`,
        eventKey: `pr-review:${pullRequest._id}:${reviewValue?._id || now.getTime()}`,
        metadata: { pullRequest: pullRequest._id, review: reviewValue?._id, decision },
      });
      return res.status(201).json({ message: "Review submitted", review: reviewValue, reviewSummary: reviewSummary(pullRequest.reviews, commitHead) });
    } catch (error) { return sendError(res, error); }
  }

  return { close, comment, create, details, list, listReviews, merge, reopen, review, update };
}

module.exports = { createPullRequestController, ...createPullRequestController() };
