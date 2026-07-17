const mongoose = require("mongoose");
const Profile = require("../models/contributorSkillProfileModel");
const Session = require("../models/contributionSessionModel");
const SkillProgress = require("../models/contributorSkillProgressModel");
const Issue = require("../models/issueModel");
const PullRequest = require("../models/pullRequestModel");
const RepositoryMember = require("../models/repositoryMemberModel");
const MentorRequest = require("../models/mentorRequestModel");
const User = require("../models/userModel");
const { validateProfile } = require("../services/contributionProfileService");
const { validateGuide } = require("../services/contributionGuideService");
const { scoreRecommendation } = require("../services/contributionRecommendationService");
const { analyzeRelevantFiles } = require("../services/contributionFileAnalysisService");
const { validateSessionEvidence } = require("../services/contributionValidationService");
const { calculateProgress } = require("../services/contributionProgressService");
const { buildSkillReport } = require("../services/contributionReportService");
const { assertRepositoryPermission, resolveRepositoryPermissionContext } = require("../services/repositoryPermissionService");
const { REPOSITORY_PERMISSIONS: P, REPOSITORY_ROLES } = require("../constants/repositoryPermissions");
const { ACTIVE_SESSION_STATUSES } = require("../constants/contributionConstants");
const { ensureDefaultBranch, validateBranchName } = require("../utils/branches");
const { commitRepo } = require("./commit");
const pullRequestController = require("./pullRequestController");
const { createNotification, safeNotifyRepositoryWatchers } = require("../services/notificationService");

const idOf = value => String(value?._id || value?.id || value || "");
const fail = (status, message, code = "CONTRIBUTION_ERROR") => Object.assign(new Error(message), { status, code });
const sendError = (res, error) => res.status(error.status || 500).json({ error: error.status ? error.message : "Contribution operation failed", code: error.code || "CONTRIBUTION_ERROR" });
const userId = req => req.user?.id || req.user?._id;
const isOpenIssue = issue => issue.status !== "closed" && issue.closed !== true && issue.open !== false;
const sessionUrl = session => `/repo/${session.repository}/contribute/session/${session._id}`;

async function issueFor(repositoryId, value) {
  const selector = /^\d+$/.test(String(value)) ? { number: Number(value) } : (mongoose.Types.ObjectId.isValid(value) ? { _id: value } : null);
  if (!selector) throw fail(400, "Invalid issue identifier", "INVALID_ISSUE_ID");
  const issue = await Issue.findOne({ repository: repositoryId, ...selector });
  if (!issue) throw fail(404, "Issue not found", "ISSUE_NOT_FOUND");
  return issue;
}

async function sessionContext(req, { manager = false } = {}) {
  const session = await Session.findOne({ _id: req.params.sessionId, repository: req.params.repoId });
  if (!session) throw fail(404, "Contribution session not found", "SESSION_NOT_FOUND");
  const access = await resolveRepositoryPermissionContext(req.params.repoId, userId(req));
  const owns = idOf(session.contributor) === idOf(userId(req));
  const manages = [REPOSITORY_ROLES.OWNER, REPOSITORY_ROLES.MAINTAINER].includes(access.role);
  if ((manager && !manages) || (!manager && !owns && !manages)) throw fail(403, "You cannot access this contribution session", "FORBIDDEN");
  const issue = await Issue.findById(session.issue);
  return { session, issue, access, owns, manages, repository: access.repository };
}

async function refresh(session, repository, issue) {
  const validation = await validateSessionEvidence(session, repository, issue);
  const files = analyzeRelevantFiles(repository, issue);
  const progress = calculateProgress(session, validation, files);
  session.latestValidationAt = new Date();
  session.latestValidation = validation;
  session.progressItems = progress.items;
  session.latestProgressPercent = progress.percent;
  if (validation.pullRequest) session.pullRequest = validation.pullRequest;
  if (validation.commitId) session.commitId = validation.commitId;
  if (validation.pullRequest) session.status = "pull_request_created";
  else if (validation.commitId) session.status = "committed";
  else if (validation.changedFiles.length) session.status = "in_progress";
  await session.save();
  return { validation, progress, relevantFiles: files };
}

async function getProfile(req, res) {
  try { return res.json({ profile: await Profile.findOne({ user: userId(req) }) }); } catch (error) { return sendError(res, error); }
}
async function putProfile(req, res) {
  try {
    const values = validateProfile(req.body);
    const profile = await Profile.findOneAndUpdate({ user: userId(req) }, { $set: values, $setOnInsert: { user: userId(req) } }, { new: true, upsert: true, runValidators: true });
    return res.json({ message: "Contribution profile saved", profile });
  } catch (error) { return sendError(res, error); }
}
async function history(req, res) {
  try {
    const [sessions, progress] = await Promise.all([
      Session.find({ contributor: userId(req) }).populate("repository", "name").populate("issue", "number title").sort({ updatedAt: -1 }).limit(100),
      SkillProgress.find({ user: userId(req) }).sort({ createdAt: -1 }).limit(100),
    ]);
    return res.json({ sessions, skillProgress: progress });
  } catch (error) { return sendError(res, error); }
}

async function getGuide(req, res) {
  try {
    const issue = await issueFor(req.params.repoId, req.params.issueId);
    const access = await resolveRepositoryPermissionContext(req.params.repoId, userId(req), { skipExpirationWrite: true });
    return res.json({ issue: { _id: issue._id, number: issue.number, title: issue.title }, contributionGuide: issue.contributionGuide, canManage: [REPOSITORY_ROLES.OWNER, REPOSITORY_ROLES.MAINTAINER].includes(access.role) });
  } catch (error) { return sendError(res, error); }
}
async function putGuide(req, res) {
  try {
    const access = await assertRepositoryPermission(req.params.repoId, userId(req), P.ISSUE_UPDATE);
    if (![REPOSITORY_ROLES.OWNER, REPOSITORY_ROLES.MAINTAINER].includes(access.role)) throw fail(403, "Only repository owners and maintainers can configure contribution guides", "FORBIDDEN");
    const issue = await issueFor(req.params.repoId, req.params.issueId);
    issue.contributionGuide = validateGuide(req.body, userId(req));
    await issue.save();
    return res.json({ message: "Contribution guide saved", contributionGuide: issue.contributionGuide });
  } catch (error) { return sendError(res, error); }
}
async function deleteGuide(req, res) {
  try {
    const access = await assertRepositoryPermission(req.params.repoId, userId(req), P.ISSUE_UPDATE);
    if (![REPOSITORY_ROLES.OWNER, REPOSITORY_ROLES.MAINTAINER].includes(access.role)) throw fail(403, "Only repository owners and maintainers can disable contribution guides", "FORBIDDEN");
    const issue = await issueFor(req.params.repoId, req.params.issueId);
    issue.contributionGuide = validateGuide({ enabled: false }, userId(req));
    await issue.save();
    return res.json({ message: "Contribution guide disabled" });
  } catch (error) { return sendError(res, error); }
}

async function recommendationsFor(req, res, one = false) {
  try {
    const profile = await Profile.findOne({ user: userId(req) });
    if (!profile) throw fail(409, "Create your contribution profile first", "PROFILE_REQUIRED");
    const access = await resolveRepositoryPermissionContext(req.params.repoId, userId(req));
    const repositoryActive = access.repository.archived !== true && access.repository.isArchived !== true;
    const canBranch = repositoryActive && access.permissions.includes(P.BRANCH_CREATE);
    const canPull = repositoryActive && access.permissions.includes(P.PULL_CREATE);
    const filter = { repository: req.params.repoId, "contributionGuide.enabled": true };
    if (one) Object.assign(filter, /^\d+$/.test(req.params.issueId) ? { number: Number(req.params.issueId) } : { _id: req.params.issueId });
    const issues = await Issue.find(filter).sort({ updatedAt: -1 }).limit(one ? 1 : 100);
    const recommendations = issues.filter(isOpenIssue).map(issue => ({ ...scoreRecommendation(profile, issue, { eligible: canBranch && canPull }), relevantFiles: analyzeRelevantFiles(access.repository, issue), issueBody: issue.body }));
    if (one && !recommendations.length) throw fail(404, "Guided issue not found", "GUIDED_ISSUE_NOT_FOUND");
    recommendations.sort((a, b) => b.suitabilityScore - a.suitabilityScore || a.issueNumber - b.issueNumber);
    return res.json(one ? { recommendation: recommendations[0], profile } : { recommendations, profile, eligibility: { canCreateBranch: canBranch, canCreatePullRequest: canPull } });
  } catch (error) { return sendError(res, error); }
}
const recommendations = (req, res) => recommendationsFor(req, res, false);
const recommendationDetails = (req, res) => recommendationsFor(req, res, true);

async function createSession(req, res) {
  try {
    const profile = await Profile.findOne({ user: userId(req) });
    if (!profile) throw fail(409, "Create your contribution profile first", "PROFILE_REQUIRED");
    const issue = await issueFor(req.params.repoId, req.body.issueId || req.body.issueNumber);
    if (!issue.contributionGuide?.enabled || !isOpenIssue(issue)) throw fail(409, "This issue is not available for guided contribution", "ISSUE_NOT_ACTIONABLE");
    const access = await resolveRepositoryPermissionContext(req.params.repoId, userId(req));
    const eligible = access.repository.archived !== true && access.repository.isArchived !== true && access.permissions.includes(P.BRANCH_CREATE) && access.permissions.includes(P.PULL_CREATE);
    if (!eligible) throw fail(403, "Your current repository access cannot start this contribution workflow", "CONTRIBUTION_NOT_ACTIONABLE");
    const recommendation = scoreRecommendation(profile, issue, { eligible });
    const existing = await Session.findOne({ repository: req.params.repoId, issue: issue._id, contributor: userId(req), status: { $in: ACTIVE_SESSION_STATUSES } });
    if (existing) throw fail(409, "An active guided session already exists for this issue", "DUPLICATE_ACTIVE_SESSION");
    const session = await Session.create({ repository: req.params.repoId, issue: issue._id, contributor: userId(req), status: "selected", skillProfileSnapshot: profile.toObject(), recommendationSnapshot: recommendation, baseBranch: ensureDefaultBranch(access.repository).name, selectedRelevantFiles: analyzeRelevantFiles(access.repository, issue).map(value => value.path) });
    await safeNotifyRepositoryWatchers(access.repository, { actor: userId(req), type: "contribution_started", title: `Guided contribution started in ${access.repository.name}`, message: `Issue #${issue.number}: ${issue.title}`, url: sessionUrl(session), eventKey: `contribution-start:${session._id}`, metadata: { session: session._id, issue: issue._id } });
    return res.status(201).json({ message: "Contribution session started", session });
  } catch (error) { return sendError(res, error); }
}
async function listSessions(req, res) {
  try {
    const access = await resolveRepositoryPermissionContext(req.params.repoId, userId(req));
    const manages = [REPOSITORY_ROLES.OWNER, REPOSITORY_ROLES.MAINTAINER].includes(access.role);
    const filter = { repository: req.params.repoId, ...(manages && req.query.scope === "repository" ? {} : { contributor: userId(req) }) };
    return res.json({ sessions: await Session.find(filter).populate("issue", "number title status").populate("contributor", "username name").sort({ updatedAt: -1 }).limit(100) });
  } catch (error) { return sendError(res, error); }
}
async function sessionDetails(req, res) {
  try {
    const context = await sessionContext(req);
    const state = await refresh(context.session, context.repository, context.issue);
    const guidance = { suggestedCommitMessage: `${context.issue.contributionGuide?.taskType === "Documentation" ? "docs" : "fix"}: ${context.issue.title} (#${context.issue.number})`, suggestedPullRequestTitle: context.issue.title, suggestedPullRequestDescription: `Guided contribution for issue #${context.issue.number}\n\nDescribe the change, validation evidence, and any remaining limitations.` };
    return res.json({ session: context.session, issue: context.issue, ...state, guidance, canManage: context.manages });
  } catch (error) { return sendError(res, error); }
}

function proposedBranch(user, issue, session) {
  const slug = String(user?.username || user?.name || "contributor").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "contributor";
  return validateBranchName(`contribute/${slug}/issue-${issue.number || idOf(issue._id).slice(-6)}-${idOf(session._id).slice(-5)}`);
}
async function createSessionBranch(req, res) {
  try {
    const { session, issue, access, repository } = await sessionContext(req);
    if (session.branchName && repository.branches.some(value => value.name === session.branchName)) return res.json({ message: "Contribution branch already exists", session });
    const account = await User.findById(userId(req)).select("username name");
    const name = session.branchName || proposedBranch(account, issue, session);
    if (access.role === REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR && !(access.membership?.allowedBranches || []).includes(name)) {
      session.branchName = name; session.branchApprovalRequired = true; session.status = "blocked"; await session.save();
      await createNotification({ recipient: repository.owner, actor: userId(req), repository: repository._id, type: "contribution_branch_approval", title: "Contribution branch approval requested", message: `${account?.username || "A contributor"} needs access to ${name}`, url: sessionUrl(session), eventKey: `contribution-branch-approval:${session._id}`, metadata: { session: session._id, branch: name } });
      return res.status(202).json({ message: "A maintainer must approve this branch for your temporary access", approvalRequired: true, session });
    }
    await assertRepositoryPermission(req.params.repoId, userId(req), P.BRANCH_CREATE, { branch: name });
    if (repository.branches.some(value => value.name === name)) throw fail(409, "Branch already exists", "BRANCH_EXISTS");
    const base = repository.branches.find(value => value.name === session.baseBranch) || ensureDefaultBranch(repository);
    repository.branches.push({ name, head: base.head || null, isDefault: false }); await repository.save();
    session.branchName = name; session.branchCreatedAt = new Date(); session.branchApprovalRequired = false; session.status = "branch_created"; await session.save();
    return res.status(201).json({ message: "Personal contribution branch created", branch: { name, sourceBranch: base.name }, session });
  } catch (error) { return sendError(res, error); }
}
async function updateSession(req, res) {
  try {
    const action = String(req.body.action || "");
    if (["approve_branch", "block", "confirm_check"].includes(action)) {
      const context = await sessionContext(req, { manager: action !== "confirm_check" });
      if (action === "approve_branch") {
        if (!context.session.branchName) throw fail(409, "No branch is awaiting approval", "NO_BRANCH_REQUEST");
        const member = await RepositoryMember.findOne({ repository: req.params.repoId, user: context.session.contributor });
        if (!member || member.role !== REPOSITORY_ROLES.TEMPORARY_CONTRIBUTOR) throw fail(409, "Branch approval only applies to temporary contributors", "APPROVAL_NOT_REQUIRED");
        if (!member.allowedBranches.includes(context.session.branchName)) member.allowedBranches.push(context.session.branchName);
        await member.save(); context.session.branchApprovedAt = new Date(); context.session.branchApprovalRequired = false; context.session.status = "selected";
      } else if (action === "block") { context.session.status = "blocked"; }
      else {
        const key = String(req.body.key || "").slice(0, 100);
        const check = context.issue.contributionGuide?.completionChecks?.find(value => value.key === key && value.checkType === "maintainer_confirmation");
        if (!check) throw fail(400, "Maintainer confirmation check not found", "INVALID_CHECK");
        const row = context.session.progressItems.find(value => value.key === key);
        if (row) { row.status = "completed"; row.completedAt = new Date(); row.confirmedBy = userId(req); }
        else context.session.progressItems.push({ key, label: check.label, status: "completed", evidenceType: "maintainer_confirmation", completedAt: new Date(), confirmedBy: userId(req) });
      }
      await context.session.save(); return res.json({ message: "Contribution session updated", session: context.session });
    }
    const { session, owns } = await sessionContext(req);
    if (!owns) throw fail(403, "Only the contributor can update this session", "FORBIDDEN");
    if (action === "abandon") { session.status = "abandoned"; session.abandonedAt = new Date(); await session.save(); return res.json({ message: "Contribution session abandoned", session }); }
    throw fail(400, "Unsupported session action", "INVALID_ACTION");
  } catch (error) { return sendError(res, error); }
}
async function abandonSession(req, res) { req.body = { action: "abandon" }; return updateSession(req, res); }
async function validateSession(req, res) {
  try { const context = await sessionContext(req); const state = await refresh(context.session, context.repository, context.issue); return res.json({ message: "Stored repository evidence validated; no repository code was executed", session: context.session, ...state }); } catch (error) { return sendError(res, error); }
}
async function confirmCheck(req, res) {
  try {
    const { session, issue, owns } = await sessionContext(req); if (!owns) throw fail(403, "Only the contributor can confirm this check", "FORBIDDEN");
    const key = String(req.body.key || "").slice(0, 100), check = issue.contributionGuide?.completionChecks?.find(value => value.key === key && value.checkType === "user_confirmation");
    if (!check) throw fail(400, "User confirmation check not found", "INVALID_CHECK");
    session.userConfirmations.set(key, Boolean(req.body.confirmed)); await session.save(); return res.json({ message: "Confirmation recorded", session });
  } catch (error) { return sendError(res, error); }
}
async function commitSession(req, res) {
  try {
    const { session, owns } = await sessionContext(req); if (!owns) throw fail(403, "Only the contributor can commit this session", "FORBIDDEN");
    if (req.body.confirmed !== true) throw fail(400, "Explicit commit confirmation is required", "CONFIRMATION_REQUIRED");
    if (!session.branchName) throw fail(409, "Create the contribution branch first", "BRANCH_REQUIRED");
    await assertRepositoryPermission(req.params.repoId, userId(req), P.COMMIT_CREATE, { branch: session.branchName });
    const message = String(req.body.message || "").trim(); if (!message) throw fail(400, "Commit message is required", "COMMIT_MESSAGE_REQUIRED");
    const commit = await commitRepo(req.params.repoId, message, { ...req.body, branch: session.branchName, authenticatedUserId: userId(req) });
    session.commitId = commit.hash || commit.id; session.status = "committed"; await session.save();
    return res.json({ message: "Commit created locally. Push it with the existing repository workflow before opening a pull request.", commit, session });
  } catch (error) { return sendError(res, error); }
}
async function pullRequestSession(req, res) {
  try {
    const context = await sessionContext(req); if (!context.owns) throw fail(403, "Only the contributor can open this pull request", "FORBIDDEN");
    if (req.body.confirmed !== true) throw fail(400, "Explicit pull-request confirmation is required", "CONFIRMATION_REQUIRED");
    if (!context.session.branchName) throw fail(409, "Create and push the contribution branch first", "BRANCH_REQUIRED");
    await assertRepositoryPermission(req.params.repoId, userId(req), P.PULL_CREATE, { branch: context.session.branchName });
    const capture = { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
    await pullRequestController.create({ ...req, repository: context.repository, params: { id: req.params.repoId }, body: { title: req.body.title || context.issue.title, description: req.body.description || `Guided contribution for issue #${context.issue.number}`, baseBranch: context.session.baseBranch, compareBranch: context.session.branchName } }, capture);
    if (capture.statusCode >= 400) return res.status(capture.statusCode).json(capture.payload);
    context.session.pullRequest = capture.payload.pullRequest._id; context.session.status = "pull_request_created"; await context.session.save();
    return res.status(capture.statusCode).json({ ...capture.payload, session: context.session });
  } catch (error) { return sendError(res, error); }
}
async function mentorRequest(req, res) {
  try {
    const { session, issue, repository, owns } = await sessionContext(req); if (!owns) throw fail(403, "Only the contributor can request a mentor", "FORBIDDEN");
    const requestedMentor = req.body.mentorId || repository.owner; if (idOf(requestedMentor) === idOf(userId(req))) throw fail(400, "Choose another repository member as mentor", "INVALID_MENTOR");
    const mentor = await MentorRequest.create({ repository: repository._id, issue: issue._id, contributionSession: session._id, requester: userId(req), requestedMentor, message: String(req.body.message || "").trim().slice(0, 2000) });
    session.mentorRequest = mentor._id; await session.save();
    await createNotification({ recipient: requestedMentor, actor: userId(req), repository: repository._id, type: "mentor_request", title: "Guided contribution mentor request", message: `Help requested for issue #${issue.number}`, url: sessionUrl(session), eventKey: `contribution-mentor:${mentor._id}`, metadata: { mentorRequest: mentor._id, session: session._id } });
    return res.status(201).json({ message: "Mentor request sent", mentorRequest: mentor, session });
  } catch (error) { return sendError(res, error); }
}
async function completeSession(req, res) {
  try {
    const { session, issue, repository, owns } = await sessionContext(req); if (!owns) throw fail(403, "Only the contributor can complete this session", "FORBIDDEN");
    if (session.status === "completed" && session.finalReport) return res.json({ message: "Contribution was already completed", session, report: session.finalReport });
    const state = await refresh(session, repository, issue);
    if (!state.validation.commitId || !state.validation.pullRequest) throw fail(409, "A stored commit and pull request are required before completion", "EVIDENCE_REQUIRED");
    const requiredFailures = state.validation.checks.filter(value => value.required && value.status !== "passed");
    if (requiredFailures.length) throw fail(409, "Required completion checks are not yet satisfied", "CHECKS_INCOMPLETE");
    const report = buildSkillReport(session, repository, issue, state.validation);
    session.status = "completed"; session.completedAt = new Date(); session.finalScore = report.score; session.finalReport = report; session.latestProgressPercent = 100; await session.save();
    await SkillProgress.findOneAndUpdate({ contributionSession: session._id }, { $setOnInsert: { user: session.contributor, repository: repository._id, issue: issue._id, contributionSession: session._id }, $set: { skillsDemonstrated: report.skillsDemonstrated, skillsToImprove: report.skillsToImprove, score: report.score, reportVersion: report.reportVersion } }, { upsert: true, new: true });
    await Profile.updateOne({ user: session.contributor }, { $inc: { completedContributionCount: 1 } });
    await safeNotifyRepositoryWatchers(repository, { actor: userId(req), type: "contribution_completed", title: `Guided contribution completed in ${repository.name}`, message: `Issue #${issue.number}: ${issue.title}`, url: sessionUrl(session), eventKey: `contribution-complete:${session._id}`, metadata: { session: session._id, score: report.score } });
    return res.json({ message: "Contribution completed from stored evidence", session, report });
  } catch (error) { return sendError(res, error); }
}
async function report(req, res) {
  try { const { session } = await sessionContext(req); if (!session.finalReport) throw fail(409, "Complete the contribution before viewing its final report", "REPORT_NOT_READY"); return res.json({ report: session.finalReport, session }); } catch (error) { return sendError(res, error); }
}

module.exports = { getProfile, putProfile, history, getGuide, putGuide, deleteGuide, recommendations, recommendationDetails, createSession, listSessions, sessionDetails, createSessionBranch, updateSession, abandonSession, validateSession, confirmCheck, commitSession, pullRequestSession, mentorRequest, completeSession, report, proposedBranch };
