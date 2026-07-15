const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const Issue = require("../models/issueModel");
const PullRequest = require("../models/pullRequestModel");
const Tag = require("../models/tagModel");
const Release = require("../models/releaseModel");
const WorkflowRun = require("../models/workflowRunModel");
const { canViewRepository } = require("../services/repositoryPermissionService");
const insights = require("../services/repositoryInsightsService");

const repositoryFields = "_id name owner visibility defaultBranch branches branchProtections stars watchers forks language collaborators.user collaborators.role createdAt updatedAt";
function sendError(res, error) {
  if (!error.status) console.error("Repository insights failed:", error.message);
  return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load repository insights" });
}

function createRepositoryInsightsController({ RepositoryModel = Repository, IssueModel = Issue, PullRequestModel = PullRequest, TagModel = null, ReleaseModel = null, WorkflowRunModel = null } = {}) {
  async function context(req) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw insights.insightError(400, "Invalid repository ID");
    const repository = await RepositoryModel.findById(req.params.id).select(repositoryFields).populate("owner", "_id username name avatarUrl").lean();
    if (!repository) throw insights.insightError(404, "Repository not found");
    const userId = String(req.user?.id || "");
    if (!canViewRepository(repository, userId)) throw insights.insightError(userId ? 403 : 401, userId ? "You do not have access to this repository" : "Authentication required");
    return { Repository: RepositoryModel, Issue: IssueModel, PullRequest: PullRequestModel, Tag: TagModel, Release: ReleaseModel, WorkflowRun: WorkflowRunModel, repository, range: insights.parseRange(req.query), query: req.query || {} };
  }
  const endpoint = (handler) => async (req, res) => { try { return res.json(await handler(await context(req), req)); } catch (error) { return sendError(res, error); } };
  return {
    overview: endpoint((ctx) => insights.getOverview(ctx)),
    commits: endpoint((ctx) => insights.getCommitActivity({ ...ctx, branch: ctx.query.branch })),
    contributors: endpoint((ctx) => insights.getContributors(ctx)),
    languages: endpoint((ctx) => insights.getLanguages({ ...ctx, branch: ctx.query.branch })),
    branches: endpoint((ctx) => insights.getBranchAnalytics(ctx)),
    issues: endpoint((ctx) => insights.getIssueAnalytics(ctx)),
    pullRequests: endpoint((ctx) => insights.getPullRequestAnalytics(ctx)),
    activity: endpoint((ctx) => insights.getRecentActivity(ctx)),
    files: endpoint((ctx) => insights.getMostChangedFiles(ctx)),
    actions: endpoint((ctx) => insights.getWorkflowAnalytics(ctx)),
  };
}

module.exports = { createRepositoryInsightsController, ...createRepositoryInsightsController({ TagModel: Tag, ReleaseModel: Release, WorkflowRunModel: WorkflowRun }) };
