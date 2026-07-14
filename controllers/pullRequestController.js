const PullRequest = require("../models/pullRequestModel");
const Repository = require("../models/repoModel");
const User = require("../models/userModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { compareRepository } = require("../services/compareService");
const { branchByName } = require("../services/branchService");
const {
  canEditPullRequest,
  cleanText,
  createMergeCommit,
  httpError,
  idOf,
  validPullNumber,
} = require("../services/pullRequestService");
const { validateBranchName } = require("../utils/branches");

const safeAuthorFields = "_id username avatarUrl";

function sendError(res, error) {
  if (!error.status) console.error("Pull request operation failed:", error.message);
  const body = { error: error.status ? error.message : "Pull request operation failed" };
  if (error.conflicts) body.conflicts = error.conflicts;
  return res.status(error.status || 500).json(body);
}

function pullObject(document) {
  const value = document?.toObject ? document.toObject() : document;
  if (!value) return null;
  return { ...value, commentCount: value.comments?.length || 0 };
}

function createPullRequestController({
  PullModel = PullRequest,
  RepoModel = Repository,
  UserModel = User,
  compare = compareRepository,
  storage = s3,
  bucket = S3_BUCKET,
} = {}) {
  const compareLive = (repository, base, compareBranch) => compare(repository, base, compareBranch, { s3: storage, bucket });

  async function findPull(repositoryId, number, populate = true) {
    const query = PullModel.findOne({ repository: repositoryId, number: validPullNumber(number) });
    if (!populate) return query;
    return query.populate("author", safeAuthorFields)
      .populate("mergedBy", safeAuthorFields)
      .populate("comments.author", safeAuthorFields);
  }

  async function create(req, res) {
    try {
      const repository = req.repository;
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
        author: req.user.id,
        baseBranch,
        compareBranch,
        baseHeadAtCreation: branchByName(repository, baseBranch)?.head || null,
        compareHeadAtCreation: branchByName(repository, compareBranch)?.head || null,
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
      const comparison = await compareLive(req.repository, pullRequest.baseBranch, pullRequest.compareBranch);
      const hasChanges = comparison.summary.filesChanged > 0;
      const hasConflicts = Boolean(comparison.summary.hasConflicts);
      return res.json({
        pullRequest: pullObject(pullRequest),
        comparison,
        branchesChangedSinceCreation: {
          base: String(branchByName(req.repository, pullRequest.baseBranch)?.head || "") !== String(pullRequest.baseHeadAtCreation || ""),
          compare: String(branchByName(req.repository, pullRequest.compareBranch)?.head || "") !== String(pullRequest.compareHeadAtCreation || ""),
        },
        permissions: {
          canEdit: canEditPullRequest(pullRequest, req.repository, req.user?.id),
          canMerge: Boolean(req.user?.id) && idOf(req.repository.owner) === String(req.user.id),
          canComment: Boolean(req.user?.id),
        },
        mergeability: {
          canMerge: pullRequest.status === "open" && hasChanges && !hasConflicts,
          hasConflicts,
          reason: pullRequest.status !== "open"
            ? `Pull request is ${pullRequest.status}`
            : (!hasChanges ? "Branches have no changes" : (hasConflicts ? "Pull request has merge conflicts" : null)),
        },
      });
    } catch (error) { return sendError(res, error); }
  }

  async function update(req, res) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      if (!canEditPullRequest(pullRequest, req.repository, req.user.id)) throw httpError(403, "You do not have permission to edit this pull request");
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
      const body = cleanText(req.body?.body, 5000, "Comment", true);
      pullRequest.comments.push({ author: req.user.id, body });
      await pullRequest.save();
      const created = pullRequest.comments.at(-1);
      const author = await UserModel.findById(req.user.id).select(safeAuthorFields).lean();
      return res.status(201).json({ message: "Comment added", comment: { ...created.toObject(), author } });
    } catch (error) { return sendError(res, error); }
  }

  async function setClosed(req, res, reopening) {
    try {
      const pullRequest = await findPull(req.repository._id, req.params.number, false);
      if (!pullRequest) throw httpError(404, "Pull request not found");
      if (!canEditPullRequest(pullRequest, req.repository, req.user.id)) throw httpError(403, "You do not have permission to update this pull request");
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
      if (pullRequest.status !== "open") throw httpError(409, `Pull request is already ${pullRequest.status}`);
      const comparison = await compareLive(req.repository, pullRequest.baseBranch, pullRequest.compareBranch);
      if (!comparison.summary.filesChanged) throw httpError(409, "Pull request has no changes to merge");
      if (comparison.summary.hasConflicts) {
        throw httpError(409, "Pull request has merge conflicts", { conflicts: comparison.files.filter((file) => file.conflict) });
      }
      const commit = createMergeCommit(req.repository, pullRequest, comparison, req.user.id);
      await req.repository.save();
      pullRequest.status = "merged";
      pullRequest.mergeCommit = commit.hash;
      pullRequest.mergedBy = req.user.id;
      pullRequest.mergedAt = commit.time;
      pullRequest.closedAt = null;
      await pullRequest.save();
      return res.json({ message: "Pull request merged", pullRequest: pullObject(pullRequest), mergeCommit: commit.hash });
    } catch (error) { return sendError(res, error); }
  }

  return { close, comment, create, details, list, merge, reopen, update };
}

module.exports = { createPullRequestController, ...createPullRequestController() };
