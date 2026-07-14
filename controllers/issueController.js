const mongoose = require("mongoose");
const Issue = require("../models/issueModel");
const Repository = require("../models/repoModel");
const PullRequest = require("../models/pullRequestModel");
const User = require("../models/userModel");
const { getAccessibleRepository } = require("../utils/repositoryAccess");
const { getAuthenticatedUserId, requireAuthenticatedUser } = require("../utils/authUser");
const { safeNotifyRepositoryWatchers } = require("../services/notificationService");

const identityFields = "_id username name avatarUrl";
const priorities = new Set(["low", "medium", "high", "critical", "none"]);

function issueError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendError(res, error) {
  if (!error.status) console.error("Issue operation failed:", error.message);
  return res.status(error.status || 500).json({ error: error.status ? error.message : "Issue operation failed" });
}

function clean(value, max, field, required = false) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw issueError(400, `${field} is required`);
  if (result.length > max) throw issueError(400, `${field} must be ${max} characters or fewer`);
  return result;
}

function idOf(value) {
  return String(value?._id || value || "");
}

function safeIdentity(value) {
  if (!value || typeof value !== "object") return null;
  return { _id: value._id || value.id, username: value.username || "", name: value.name || "", avatarUrl: value.avatarUrl || "" };
}

function normalizedStatus(value) {
  if (value.status === "closed" || value.state === "closed" || value.closed === true || value.open === false) return "closed";
  return "open";
}

function issueObject(document) {
  const value = document?.toObject ? document.toObject() : document;
  if (!value) return null;
  return {
    ...value,
    number: value.number ?? String(value._id),
    body: value.body || value.description || "",
    status: normalizedStatus(value),
    priority: priorities.has(value.priority) ? value.priority : "none",
    labels: value.labels || [],
    author: safeIdentity(value.author || value.owner || value.user),
    assignees: (value.assignees || []).map(safeIdentity),
    comments: (value.comments || []).map((comment) => ({ ...comment, author: safeIdentity(comment.author) })),
    linkedPullRequests: value.linkedPullRequests || [],
    closedBy: safeIdentity(value.closedBy),
    commentCount: value.comments?.length || 0,
  };
}

function canEdit(issue, repository, userId) {
  return Boolean(userId) && [idOf(issue.author || issue.owner || issue.user), idOf(repository.owner)].includes(String(userId));
}

function issueLookup(repositoryId, identifier) {
  const raw = String(identifier || "");
  if (/^\d+$/.test(raw)) return { repository: repositoryId, number: Number(raw) };
  if (mongoose.Types.ObjectId.isValid(raw)) return { repository: repositoryId, _id: raw };
  throw issueError(400, "Invalid issue number");
}

function createIssueController({
  IssueModel = Issue,
  RepoModel = Repository,
  PullModel = PullRequest,
  UserModel = User,
  notify = safeNotifyRepositoryWatchers,
} = {}) {
  const populate = (query) => query
    .populate("author", identityFields)
    .populate("assignees", identityFields)
    .populate("comments.author", identityFields)
    .populate("closedBy", identityFields)
    .populate("linkedPullRequests", "number title status baseBranch compareBranch");

  const findIssue = (repositoryId, identifier, withPopulation = true) => {
    const query = IssueModel.findOne(issueLookup(repositoryId, identifier));
    return withPopulation ? populate(query) : query;
  };

  async function create(req, res) {
    try {
      const user = await requireAuthenticatedUser(req, UserModel);
      const title = clean(req.body?.title, 200, "Title", true);
      const body = clean(req.body?.body ?? req.body?.description, 20000, "Body");
      const priority = String(req.body?.priority || "none").toLowerCase();
      if (!priorities.has(priority)) throw issueError(400, "Invalid priority");
      const labels = normalizeLabels(req.body?.labels || []);
      const counter = await RepoModel.findByIdAndUpdate(req.repository._id, { $inc: { issueCounter: 1 } }, { new: true, projection: { issueCounter: 1 } });
      if (!counter) throw issueError(404, "Repository not found");
      const issue = await IssueModel.create({ repository: req.repository._id, number: counter.issueCounter, title, body, description: body, author: user._id, priority, labels });
      if (issue.populate) await issue.populate("author", identityFields);
      await notify(req.repository, {
        actor: user._id, type: "issue_opened", title: `New issue in ${req.repository.name}`,
        message: `#${issue.number}: ${title}`, url: `/repo/${req.repository._id}/issues/${issue.number}`,
        eventKey: `issue-open:${issue._id || issue.number}`, metadata: { issue: issue._id, number: issue.number },
      });
      return res.status(201).json({ message: "Issue created", issue: issueObject(issue) });
    } catch (error) { return sendError(res, error); }
  }

  async function list(req, res) {
    try {
      const status = String(req.query?.status || "open").toLowerCase();
      if (!new Set(["open", "closed", "all"]).has(status)) throw issueError(400, "Invalid issue status");
      const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 20));
      const filter = { repository: req.repository._id };
      if (status !== "all") filter.status = status;
      if (req.query?.search) {
        const escaped = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ title: new RegExp(escaped, "i") }, { body: new RegExp(escaped, "i") }, { description: new RegExp(escaped, "i") }];
      }
      if (req.query?.label) filter["labels.name"] = new RegExp(`^${String(req.query.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      if (req.query?.priority) filter.priority = String(req.query.priority).toLowerCase();
      if (req.query?.assignee) {
        if (!mongoose.Types.ObjectId.isValid(req.query.assignee)) throw issueError(400, "Invalid assignee");
        filter.assignees = req.query.assignee;
      }
      const sortName = String(req.query?.sort || "updated");
      const sort = sortName === "created" ? { createdAt: -1 } : sortName === "comments" ? { comments: -1, updatedAt: -1 } : { updatedAt: -1 };
      const baseFilter = { repository: req.repository._id };
      const [documents, total, open, closed] = await Promise.all([
        populate(IssueModel.find(filter)).sort(sort).skip((page - 1) * limit).limit(limit),
        IssueModel.countDocuments(filter),
        IssueModel.countDocuments({ ...baseFilter, status: "open" }),
        IssueModel.countDocuments({ ...baseFilter, status: "closed" }),
      ]);
      return res.json({ issues: documents.map(issueObject), counts: { open, closed, total: open + closed }, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) { return sendError(res, error); }
  }

  async function details(req, res) {
    try {
      const issue = await findIssue(req.repository._id, req.params.number);
      if (!issue) throw issueError(404, "Issue not found");
      const userId = getAuthenticatedUserId(req);
      return res.json({ issue: issueObject(issue), permissions: { canEdit: canEdit(issue, req.repository, userId), canManage: Boolean(userId) && idOf(req.repository.owner) === String(userId), canComment: Boolean(userId) } });
    } catch (error) { return sendError(res, error); }
  }

  async function update(req, res) {
    try {
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      const userId = getAuthenticatedUserId(req);
      if (!canEdit(issue, req.repository, userId)) throw issueError(403, "You do not have permission to edit this issue");
      if (Object.hasOwn(req.body || {}, "title")) issue.title = clean(req.body.title, 200, "Title", true);
      if (Object.hasOwn(req.body || {}, "body")) { issue.body = clean(req.body.body, 20000, "Body"); issue.description = issue.body; }
      if (Object.hasOwn(req.body || {}, "priority")) {
        const priority = String(req.body.priority).toLowerCase();
        if (!priorities.has(priority)) throw issueError(400, "Invalid priority");
        issue.priority = priority;
      }
      await issue.save();
      return res.json({ message: "Issue updated", issue: issueObject(issue) });
    } catch (error) { return sendError(res, error); }
  }

  async function comment(req, res) {
    try {
      const user = await requireAuthenticatedUser(req, UserModel);
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      const body = clean(req.body?.body, 10000, "Comment", true);
      const now = new Date();
      issue.comments.push({ author: user._id, body, createdAt: now, updatedAt: now });
      issue.updatedAt = now;
      await issue.save();
      if (issue.populate) await issue.populate("comments.author", identityFields);
      const created = issueObject(issue).comments.at(-1);
      await notify(req.repository, {
        actor: user._id, type: "issue_commented", title: `New comment on issue #${issue.number}`,
        message: body, url: `/repo/${req.repository._id}/issues/${issue.number}`,
        eventKey: `issue-comment:${issue._id}:${created?._id || now.getTime()}`,
        metadata: { issue: issue._id, comment: created?._id },
      });
      return res.status(201).json({ message: "Comment added", comment: created });
    } catch (error) { return sendError(res, error); }
  }

  async function setClosed(req, res, reopen) {
    try {
      const user = await requireAuthenticatedUser(req, UserModel);
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      if (!canEdit(issue, req.repository, user._id)) throw issueError(403, "You do not have permission to update this issue");
      if (reopen && normalizedStatus(issue) !== "closed") throw issueError(409, "Only a closed issue can be reopened");
      if (!reopen && normalizedStatus(issue) !== "open") throw issueError(409, "Only an open issue can be closed");
      issue.status = reopen ? "open" : "closed";
      issue.closedBy = reopen ? null : user._id;
      issue.closedAt = reopen ? null : new Date();
      await issue.save();
      if (!reopen && issue.populate) await issue.populate("closedBy", identityFields);
      await notify(req.repository, {
        actor: user._id, type: reopen ? "issue_reopened" : "issue_closed",
        title: `Issue #${issue.number} was ${reopen ? "reopened" : "closed"}`, message: issue.title,
        url: `/repo/${req.repository._id}/issues/${issue.number}`,
        eventKey: `issue-${reopen ? "reopen" : "close"}:${issue._id}:${Date.now()}`,
        metadata: { issue: issue._id },
      });
      return res.json({ message: reopen ? "Issue reopened" : "Issue closed", issue: issueObject(issue) });
    } catch (error) { return sendError(res, error); }
  }

  const close = (req, res) => setClosed(req, res, false);
  const reopen = (req, res) => setClosed(req, res, true);

  async function addLabel(req, res) {
    try {
      assertOwner(req);
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      const [label] = normalizeLabels([req.body]);
      if (issue.labels.some((item) => item.name.toLowerCase() === label.name.toLowerCase())) throw issueError(409, "Label already exists on this issue");
      issue.labels.push(label); await issue.save();
      return res.json({ message: "Label added", labels: issue.labels });
    } catch (error) { return sendError(res, error); }
  }

  async function removeLabel(req, res) {
    try {
      assertOwner(req);
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      const name = decodeURIComponent(req.params.labelName).toLowerCase();
      const before = issue.labels.length;
      issue.labels = issue.labels.filter((label) => label.name.toLowerCase() !== name);
      if (issue.labels.length === before) throw issueError(404, "Label not found");
      await issue.save(); return res.json({ message: "Label removed", labels: issue.labels });
    } catch (error) { return sendError(res, error); }
  }

  async function addAssignee(req, res) {
    try {
      assertOwner(req);
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      const userId = String(req.body?.userId || "");
      if (!mongoose.Types.ObjectId.isValid(userId)) throw issueError(400, "Invalid assignee");
      if (![idOf(req.repository.owner), idOf(issue.author || issue.owner || issue.user)].includes(userId)) throw issueError(403, "Only the repository owner or issue author can be assigned");
      const user = await UserModel.findById(userId).select(identityFields);
      if (!user) throw issueError(404, "Assignee not found");
      if (issue.assignees.some((item) => idOf(item) === userId)) throw issueError(409, "User is already assigned");
      issue.assignees.push(user._id); await issue.save();
      if (issue.populate) await issue.populate("assignees", identityFields);
      return res.json({ message: "Assignee added", assignees: issueObject(issue).assignees });
    } catch (error) { return sendError(res, error); }
  }

  async function removeAssignee(req, res) {
    try {
      assertOwner(req);
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      const userId = String(req.params.userId || "");
      issue.assignees = issue.assignees.filter((item) => idOf(item) !== userId);
      await issue.save(); return res.json({ message: "Assignee removed", assignees: issue.assignees });
    } catch (error) { return sendError(res, error); }
  }

  async function linkPullRequest(req, res) {
    try {
      assertOwner(req);
      const issue = await findIssue(req.repository._id, req.params.number, false);
      if (!issue) throw issueError(404, "Issue not found");
      const number = Number.parseInt(req.body?.pullRequestNumber, 10);
      if (!Number.isInteger(number) || number < 1) throw issueError(400, "Invalid pull request number");
      const pull = await PullModel.findOne({ repository: req.repository._id, number });
      if (!pull) throw issueError(404, "Pull request not found in this repository");
      if (issue.linkedPullRequests.some((item) => idOf(item) === idOf(pull))) throw issueError(409, "Pull request is already linked");
      issue.linkedPullRequests.push(pull._id); await issue.save();
      if (issue.populate) await issue.populate("linkedPullRequests", "number title status baseBranch compareBranch");
      return res.json({ message: "Pull request linked", linkedPullRequests: issue.linkedPullRequests });
    } catch (error) { return sendError(res, error); }
  }

  function assertOwner(req) {
    const userId = getAuthenticatedUserId(req);
    if (!userId || idOf(req.repository.owner) !== userId) throw issueError(403, "Only the repository owner can manage this issue field");
  }

  return { addAssignee, addLabel, close, comment, create, details, linkPullRequest, list, removeAssignee, removeLabel, reopen, update };
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) throw issueError(400, "Labels must be an array");
  const result = [];
  for (const value of labels) {
    const name = clean(value?.name, 50, "Label name", true);
    const color = String(value?.color || "6e7681").replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(color)) throw issueError(400, "Label color must be a six-character hex value");
    if (result.some((label) => label.name.toLowerCase() === name.toLowerCase())) throw issueError(400, "Duplicate labels are not allowed");
    result.push({ name, color: color.toLowerCase() });
  }
  return result;
}

module.exports = { createIssueController, issueObject, normalizeLabels, ...createIssueController() };
