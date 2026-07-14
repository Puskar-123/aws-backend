const mongoose = require("mongoose");
const PullRequest = require("../models/pullRequestModel");
const User = require("../models/userModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { compareRepository } = require("../services/compareService");
const { branchByName } = require("../services/branchService");
const { createNotification } = require("../services/notificationService");
const { getBranchProtection } = require("../services/branchProtectionService");
const { getRepositoryRole, hasRepositoryPermission } = require("../services/repositoryPermissionService");
const { getRequestedReviewerStatus, getReviewMergeStatus, threadIsOutdated } = require("../services/pullRequestReviewService");
const { cleanText, httpError, idOf, validPullNumber } = require("../services/pullRequestService");
const { isProtectedDiffPath } = require("../services/diffService");
const { normalizeRepoPath } = require("../utils/repoPath");
const { requireAuthenticatedUser } = require("../utils/authUser");

const identityFields = "_id username name avatarUrl";
const asObject = (value) => value?.toObject ? value.toObject() : { ...value };
const safeIdentity = (value) => value && typeof value === "object"
  ? { _id: value._id || value.id, username: value.username || "", name: value.name || "", avatarUrl: value.avatarUrl || "" }
  : value ? { _id: value, username: "", name: "", avatarUrl: "" } : null;

function sendError(res, error) {
  if (!error.status) console.error("Advanced review operation failed:", error.message);
  const body = { error: error.status ? error.message : "Review operation failed" };
  for (const field of ["code", "required", "current", "unresolvedCount"]) if (error[field] !== undefined) body[field] = error[field];
  return res.status(error.status || 500).json(body);
}

function safeComment(comment) {
  const value = asObject(comment);
  return { ...value, body: value.deleted ? "This comment was deleted." : value.body, author: safeIdentity(value.author) };
}

function safeThread(thread, currentHead) {
  const value = asObject(thread);
  return {
    ...value,
    outdated: threadIsOutdated(value, currentHead),
    createdBy: safeIdentity(value.createdBy),
    resolvedBy: safeIdentity(value.resolvedBy),
    comments: (value.comments || []).map(safeComment),
  };
}

function createAdvancedReviewController({
  PullModel = PullRequest, UserModel = User, compare = compareRepository,
  storage = s3, bucket = S3_BUCKET, notifyUser = createNotification,
} = {}) {
  const compareLive = (repository, pullRequest) => compare(repository, pullRequest.baseBranch, pullRequest.compareBranch, { s3: storage, bucket });
  async function findPull(repositoryId, number, populate = true) {
    let query = PullModel.findOne({ repository: repositoryId, number: validPullNumber(number) });
    if (!populate) return query;
    for (const path of ["author", "requestedReviewers.user", "requestedReviewers.requestedBy", "reviewThreads.createdBy", "reviewThreads.resolvedBy", "reviewThreads.comments.author", "reviews.reviewer"]) {
      query = query.populate(path, identityFields);
    }
    return query;
  }
  const requireOpen = (pullRequest) => {
    if (pullRequest.status !== "open") throw httpError(409, `A ${pullRequest.status} pull request cannot be reviewed`);
  };
  async function notifyRecipients(repository, pullRequest, actor, recipients, input) {
    const ids = [...new Set(recipients.map(idOf).filter((id) => id && id !== idOf(actor)))];
    await Promise.all(ids.map(async (recipient) => {
      try {
        return await notifyUser({
          recipient, actor, repository: repository._id, url: `/repo/${repository._id}/pulls/${pullRequest.number}`,
          ...input, eventKey: input.eventKey ? `${input.eventKey}:${recipient}` : null,
        });
      } catch (error) { console.error("Review notification failed:", error.message); return null; }
    }));
  }
  const threadParticipants = (pullRequest, thread) => [pullRequest.author, ...(thread.comments || []).map((comment) => comment.author)];

  async function reviewers(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const candidateIds = [...new Set([req.repository.owner, ...(req.repository.collaborators || []).map((item) => item.user)].map(idOf))]
        .filter((id) => id !== idOf(pullRequest.author) && hasRepositoryPermission(req.repository, id, "review_pr"));
      const users = candidateIds.length ? await UserModel.find({ _id: { $in: candidateIds } }).select(identityFields) : [];
      const requested = getRequestedReviewerStatus(pullRequest, req.repository).filter((item) => item.status !== "removed").map((item) => ({ ...asObject(item), user: safeIdentity(item.user), requestedBy: safeIdentity(item.requestedBy) }));
      const requestedIds = new Set(requested.map((item) => idOf(item.user)));
      return res.json({ requestedReviewers: requested, candidates: users.map((user) => ({ ...safeIdentity(user), role: getRepositoryRole(req.repository, user._id) })).filter((user) => !requestedIds.has(idOf(user))) });
    } catch (error) { return sendError(res, error); }
  }

  async function requestReviewer(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      requireOpen(pullRequest);
      const actor = await requireAuthenticatedUser(req, UserModel);
      if (idOf(pullRequest.author) !== idOf(actor) && !hasRepositoryPermission(req.repository, actor._id, "merge_pr")) throw httpError(403, "You do not have permission to request reviewers");
      let reviewer;
      if (req.body?.userId) {
        if (!mongoose.Types.ObjectId.isValid(req.body.userId)) throw httpError(400, "Invalid reviewer ID");
        reviewer = await UserModel.findById(req.body.userId).select(identityFields);
      } else {
        const username = cleanText(req.body?.username, 100, "Username", true);
        reviewer = await UserModel.findOne({ username }).select(identityFields);
      }
      if (!reviewer) throw httpError(404, "Reviewer not found");
      if (idOf(reviewer) === idOf(pullRequest.author)) throw httpError(400, "The pull request author cannot be requested as a reviewer");
      if (!hasRepositoryPermission(req.repository, reviewer._id, "review_pr")) throw httpError(403, "Reviewer no longer has review access to this repository");
      const existing = (pullRequest.requestedReviewers || []).find((item) => idOf(item.user) === idOf(reviewer) && item.status !== "removed");
      if (existing) throw httpError(409, "Review has already been requested from this user");
      const previous = (pullRequest.requestedReviewers || []).find((item) => idOf(item.user) === idOf(reviewer));
      if (previous) Object.assign(previous, { status: "requested", requestedBy: actor._id, requestedAt: new Date() });
      else pullRequest.requestedReviewers.push({ user: reviewer._id, requestedBy: actor._id, requestedAt: new Date(), status: "requested" });
      await pullRequest.save();
      await notifyRecipients(req.repository, pullRequest, actor._id, [reviewer._id], { type: "review_requested", title: `Review requested on PR #${pullRequest.number}`, message: pullRequest.title, eventKey: `review-request:${pullRequest._id}:${reviewer._id}` });
      return res.status(201).json({ message: "Reviewer requested", reviewer: { user: safeIdentity(reviewer), status: "requested" } });
    } catch (error) { return sendError(res, error); }
  }

  async function removeReviewer(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const actor = await requireAuthenticatedUser(req, UserModel);
      if (idOf(pullRequest.author) !== idOf(actor) && !hasRepositoryPermission(req.repository, actor._id, "merge_pr")) throw httpError(403, "You do not have permission to remove requested reviewers");
      const request = (pullRequest.requestedReviewers || []).find((item) => idOf(item.user) === String(req.params.userId) && item.status !== "removed");
      if (!request) throw httpError(404, "Requested reviewer not found");
      request.status = "removed";
      await pullRequest.save();
      return res.json({ message: "Reviewer request removed" });
    } catch (error) { return sendError(res, error); }
  }

  async function files(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const comparison = await compareLive(req.repository, pullRequest);
      const headCommit = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      const visibleFiles = (comparison.files || []).filter((file) => !file.protected && !isProtectedDiffPath(file.path));
      return res.json({
        files: visibleFiles.map((file) => ({ ...file, threads: (pullRequest.reviewThreads || []).filter((thread) => thread.filePath === file.path).map((thread) => safeThread(thread, headCommit)) })),
        summary: comparison.summary, headCommit, baseCommit: branchByName(req.repository, pullRequest.baseBranch)?.head || null,
      });
    } catch (error) { return sendError(res, error); }
  }

  function validatePosition(comparison, input) {
    let filePath;
    try { filePath = normalizeRepoPath(input.filePath); } catch { throw httpError(400, "Invalid review file path"); }
    if (isProtectedDiffPath(filePath)) throw httpError(403, "Comments are unavailable for protected files");
    const file = (comparison.files || []).find((item) => item.path === filePath && !item.protected);
    if (!file) throw httpError(400, "File is not part of this pull request diff");
    if (file.binary || file.isBinary || file.tooLarge || file.unavailable) throw httpError(400, "Line comments are unavailable for this file");
    const side = String(input.side || "").toUpperCase();
    if (!['LEFT', 'RIGHT'].includes(side)) throw httpError(400, "Review side must be LEFT or RIGHT");
    const line = Number(input.line);
    if (!Number.isInteger(line) || line < 1) throw httpError(400, "Invalid review line");
    let matchedHunk = null;
    const found = (file.hunks || []).some((hunk) => {
      const match = (hunk.lines || []).some((item) => side === "LEFT" ? item.oldLineNumber === line : item.newLineNumber === line);
      if (match) matchedHunk = hunk;
      return match;
    });
    if (!found) throw httpError(400, "The selected line does not exist in the current diff");
    return { filePath, file, side, line, hunk: matchedHunk };
  }

  async function createThread(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      requireOpen(pullRequest);
      const actor = await requireAuthenticatedUser(req, UserModel);
      if (!hasRepositoryPermission(req.repository, actor._id, "review_pr")) throw httpError(403, "You do not have permission to comment on code review lines");
      const head = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      if (!req.body?.commitHash || String(req.body.commitHash) !== String(head)) throw httpError(409, "The pull request changed while you were reviewing it. Reload before submitting.", { code: "STALE_REVIEW" });
      const comparison = await compareLive(req.repository, pullRequest);
      const position = validatePosition(comparison, req.body || {});
      const body = cleanText(req.body?.body, 5000, "Comment", true);
      const now = new Date();
      pullRequest.reviewThreads.push({
        filePath: position.filePath, side: position.side, line: position.line, originalLine: position.line,
        startLine: Number(req.body.startLine) || position.line, originalStartLine: Number(req.body.startLine) || position.line,
        commitHash: head, originalCommitHash: head, diffHunk: JSON.stringify(position.hunk).slice(0, 10000),
        createdBy: actor._id, comments: [{ author: actor._id, body, createdAt: now, updatedAt: now }],
      });
      await pullRequest.save();
      const thread = pullRequest.reviewThreads.at(-1);
      await notifyRecipients(req.repository, pullRequest, actor._id, [pullRequest.author, ...(pullRequest.requestedReviewers || []).filter((item) => item.status !== "removed").map((item) => item.user)], { type: "review_comment", title: `New code review comment on PR #${pullRequest.number}`, message: body, eventKey: `review-comment:${thread._id}` });
      return res.status(201).json({ message: "Review thread created", thread: safeThread(thread, head) });
    } catch (error) { return sendError(res, error); }
  }

  function findThread(pullRequest, threadId) {
    return (pullRequest.reviewThreads || []).find((item) => idOf(item) === String(threadId));
  }
  function findComment(pullRequest, commentId) {
    for (const thread of pullRequest.reviewThreads || []) {
      const comment = (thread.comments || []).find((item) => idOf(item) === String(commentId));
      if (comment) return { thread, comment };
    }
    return null;
  }

  async function reply(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      requireOpen(pullRequest);
      const actor = await requireAuthenticatedUser(req, UserModel);
      const thread = findThread(pullRequest, req.params.threadId);
      if (!thread) throw httpError(404, "Review thread not found");
      const head = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      if (!req.body?.commitHash || String(req.body.commitHash) !== String(head)) throw httpError(409, "The pull request changed while you were reviewing it. Reload before submitting.", { code: "STALE_REVIEW" });
      const body = cleanText(req.body?.body, 5000, "Comment", true);
      thread.comments.push({ author: actor._id, body, createdAt: new Date(), updatedAt: new Date() });
      await pullRequest.save();
      const comment = thread.comments.at(-1);
      await notifyRecipients(req.repository, pullRequest, actor._id, threadParticipants(pullRequest, thread), { type: "review_reply", title: `New reply on PR #${pullRequest.number}`, message: body, eventKey: `review-comment:${comment._id}` });
      return res.status(201).json({ message: "Reply added", comment: safeComment(comment) });
    } catch (error) { return sendError(res, error); }
  }

  async function editComment(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const actor = await requireAuthenticatedUser(req, UserModel);
      const result = findComment(pullRequest, req.params.commentId);
      if (!result) throw httpError(404, "Review comment not found");
      if (idOf(result.comment.author) !== idOf(actor)) throw httpError(403, "You may only edit your own review comments");
      if (result.comment.deleted) throw httpError(409, "Deleted comments cannot be edited");
      result.comment.body = cleanText(req.body?.body, 5000, "Comment", true);
      result.comment.editedAt = new Date(); result.comment.updatedAt = new Date();
      await pullRequest.save();
      return res.json({ message: "Comment updated", comment: safeComment(result.comment) });
    } catch (error) { return sendError(res, error); }
  }

  async function deleteComment(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const actor = await requireAuthenticatedUser(req, UserModel);
      const result = findComment(pullRequest, req.params.commentId);
      if (!result) throw httpError(404, "Review comment not found");
      if (idOf(result.comment.author) !== idOf(actor)) throw httpError(403, "You may only delete your own review comments");
      result.comment.deleted = true; result.comment.body = ""; result.comment.editedAt = new Date(); result.comment.updatedAt = new Date();
      await pullRequest.save();
      return res.json({ message: "Comment deleted", comment: safeComment(result.comment) });
    } catch (error) { return sendError(res, error); }
  }

  async function setResolved(req, res, resolved) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      requireOpen(pullRequest);
      const actor = await requireAuthenticatedUser(req, UserModel);
      const thread = findThread(pullRequest, req.params.threadId);
      if (!thread) throw httpError(404, "Review thread not found");
      const permitted = idOf(thread.createdBy) === idOf(actor) || idOf(pullRequest.author) === idOf(actor)
        || hasRepositoryPermission(req.repository, actor._id, "review_pr");
      if (!permitted) throw httpError(403, `You do not have permission to ${resolved ? "resolve" : "reopen"} this conversation`);
      thread.resolved = resolved;
      thread.resolvedBy = resolved ? actor._id : null;
      thread.resolvedAt = resolved ? new Date() : null;
      await pullRequest.save();
      if (!resolved) await notifyRecipients(req.repository, pullRequest, actor._id, threadParticipants(pullRequest, thread), { type: "review_conversation_reopened", title: `Conversation reopened on PR #${pullRequest.number}`, message: thread.filePath, eventKey: `review-reopen:${thread._id}:${Date.now()}` });
      return res.json({ message: resolved ? "Conversation resolved" : "Conversation reopened", thread: safeThread(thread, branchByName(req.repository, pullRequest.compareBranch)?.head || null) });
    } catch (error) { return sendError(res, error); }
  }
  const resolve = (req, res) => setResolved(req, res, true);
  const reopen = (req, res) => setResolved(req, res, false);

  async function mergeStatus(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      const head = branchByName(req.repository, pullRequest.compareBranch)?.head || null;
      const protection = getBranchProtection(req.repository, pullRequest.baseBranch);
      const review = getReviewMergeStatus(req.repository, pullRequest, head, protection);
      let conflicts = false;
      if (pullRequest.status === "open") conflicts = Boolean((await compareLive(req.repository, pullRequest)).summary?.hasConflicts);
      const statusCheck = { name: "Merge conflicts", passed: !conflicts, message: conflicts ? "Conflicts must be resolved" : "No merge conflicts" };
      return res.json({ ...review, mergeable: pullRequest.status === "open" && review.mergeable && !conflicts, conflicts, checks: [...review.checks, statusCheck] });
    } catch (error) { return sendError(res, error); }
  }

  return { reviewers, requestReviewer, removeReviewer, files, createThread, reply, editComment, deleteComment, resolve, reopen, mergeStatus };
}

module.exports = { createAdvancedReviewController, safeComment, safeThread, ...createAdvancedReviewController() };
