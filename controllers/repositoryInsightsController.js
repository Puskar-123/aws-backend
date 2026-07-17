const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const Issue = require("../models/issueModel");
const PullRequest = require("../models/pullRequestModel");
const Tag = require("../models/tagModel");
const Release = require("../models/releaseModel");
const WorkflowRun = require("../models/workflowRunModel");
const WorkflowDefinition = require("../models/workflowDefinitionModel");
const RepositoryMember = require("../models/repositoryMemberModel");
const RepositoryHealthSnapshot = require("../models/repositoryHealthSnapshotModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { canViewRepository } = require("../services/repositoryPermissionService");
const insights = require("../services/repositoryInsightsService");

const repositoryFields = "_id name description owner visibility defaultBranch branches branchProtections stars watchers forks language collaborators.user collaborators.role content commits createdAt updatedAt";
function sendError(res, error) {
  if (!error.status) console.error("Repository insights failed:", error.message);
  return res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load repository insights" });
}

function createRepositoryInsightsController({ RepositoryModel = Repository, IssueModel = Issue, PullRequestModel = PullRequest, TagModel = null, ReleaseModel = null, WorkflowRunModel = null,
  WorkflowDefinitionModel = WorkflowDefinition, RepositoryMemberModel = RepositoryMember, HealthSnapshotModel = RepositoryHealthSnapshot, storage = s3, bucket = S3_BUCKET } = {}) {
  async function context(req, parseRequestedRange = true) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw insights.insightError(400, "Invalid repository ID");
    const repository = await RepositoryModel.findById(req.params.id).select(repositoryFields).populate("owner", "_id username name avatarUrl").lean();
    if (!repository) throw insights.insightError(404, "Repository not found");
    const userId = String(req.user?.id || "");
    if (!canViewRepository(repository, userId)) throw insights.insightError(userId ? 403 : 401, userId ? "You do not have access to this repository" : "Authentication required");
    return { Repository: RepositoryModel, Issue: IssueModel, PullRequest: PullRequestModel, Tag: TagModel, Release: ReleaseModel, WorkflowRun: WorkflowRunModel, repository, range: parseRequestedRange ? insights.parseRange(req.query) : null, query: req.query || {} };
  }
  const endpoint = (handler) => async (req, res) => { try { return res.json(await handler(await context(req), req)); } catch (error) { return sendError(res, error); } };
  async function health(req, res) {
    try {
      const ctx = await context(req, false); const range = String(req.query?.range || "30d"); const cached = insights.health.getCachedHealth(ctx.repository._id, range);
      if (cached) return res.json(cached);
      const [issues, pullRequests, releases, workflowRuns, workflows, ownerMemberships, expiredWriteAccess] = await Promise.all([
        IssueModel.find({ repository: ctx.repository._id }).select("status state closed labels priority createdAt updatedAt closedAt").lean(),
        PullRequestModel.find({ repository: ctx.repository._id }).select("status createdAt updatedAt mergedAt").lean(),
        ReleaseModel ? ReleaseModel.find({ repository: ctx.repository._id }).select("draft publishedAt").lean() : [],
        WorkflowRunModel ? WorkflowRunModel.find({ repository: ctx.repository._id }).select("workflowName workflowPath workflowType status createdAt completedAt").lean() : [],
        WorkflowDefinitionModel ? WorkflowDefinitionModel.find({ repository: ctx.repository._id, enabled: true }).select("name path workflowType validationStatus").lean() : [],
        RepositoryMemberModel.countDocuments({ repository: ctx.repository._id, user: ctx.repository.owner?._id || ctx.repository.owner }),
        RepositoryMemberModel.countDocuments({ repository: ctx.repository._id, role: "temporary_contributor", accessExpiresAt: { $lte: new Date() }, status: "active" }),
      ]);
      const readable = (ctx.repository.content || []).filter((f)=>/(^|\/)(readme(?:\.[^/]*)?|package\.json)$/i.test(f.path || f.filename || "") && Number(f.size || 0) <= 256000);
      const contents = {};
      await Promise.all(readable.map(async (file)=>{ const key=file.s3Key || file.storageKey; if(!key || !storage || !bucket) return; try { const object=await storage.getObject({Bucket:bucket,Key:key}).promise(); contents[(file.path||file.filename).toLowerCase()]=Buffer.from(object.Body).toString("utf8"); } catch { /* unavailable evidence stays unconfigured */ } }));
      const readmeKey=Object.keys(contents).find((key)=>(/(^|\/)readme(?:\.[^/]*)?$/i).test(key)); let packageJson={};
      try { packageJson=JSON.parse(contents[Object.keys(contents).find((key)=>(/(^|\/)package\.json$/i).test(key))] || "{}"); } catch { packageJson={}; }
      const pathCounts=new Map(); for(const file of ctx.repository.content||[]){const key=file.path||file.filename||"";pathCounts.set(key.toLowerCase(),(pathCounts.get(key.toLowerCase())||0)+1);} const fileWarnings=(ctx.repository.content||[]).filter((f)=>Number(f.size)>25*1024*1024).map(()=>"oversized"); if([...pathCounts.values()].some((n)=>n>1)) fileWarnings.push("duplicate");
      const result=insights.health.calculateRepositoryHealth({ files:ctx.repository.content, description:ctx.repository.description, readme:contents[readmeKey]||"", packageJson, commits:ctx.repository.commits,
        branchProtections:ctx.repository.branchProtections, visibility:ctx.repository.visibility, ownerDuplicate:ownerMemberships>0 || (ctx.repository.collaborators||[]).some((c)=>String(c.user)===String(ctx.repository.owner?._id||ctx.repository.owner)),
        expiredWriteAccess:expiredWriteAccess>0,fileWarnings,issues,pullRequests,releases,workflowRuns,workflows,createdAt:ctx.repository.createdAt }, {range});
      const snapshotDate=new Date(result.calculatedAt).toISOString().slice(0,10);
      await HealthSnapshotModel.updateOne({repository:ctx.repository._id,range,version:result.version,snapshotDate},{$setOnInsert:{...result,repository:ctx.repository._id,snapshotDate}},{upsert:true});
      const previous=await HealthSnapshotModel.findOne({repository:ctx.repository._id,range,version:result.version,snapshotDate:{$lt:snapshotDate}}).sort({snapshotDate:-1}).select("score calculatedAt").lean();
      const response={...result,trend:previous?{previousScore:previous.score,change:result.score-previous.score,previousCalculatedAt:previous.calculatedAt}:null};
      const role=req.repositoryRole || (String(ctx.repository.owner?._id||ctx.repository.owner)===String(req.user?.id||"")?"owner":null);
      if(!["owner","maintainer"].includes(role)) { const security=response.categories.security; security.details=security.details.map((d)=>({...d,evidence:d.label==="Sensitive-file warnings"?(d.points?"No warnings detected":"Warnings detected; details available to maintainers"):d.evidence})); }
      return res.json(insights.health.setCachedHealth(ctx.repository._id,range,response));
    } catch(error) { return sendError(res,error); }
  }
  return {
    health,
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
