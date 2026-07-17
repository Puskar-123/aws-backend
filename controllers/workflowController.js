const mongoose = require("mongoose");
const WorkflowDefinition = require("../models/workflowDefinitionModel");
const WorkflowRun = require("../models/workflowRunModel");
const CheckRun = require("../models/checkRunModel");
const PullRequest = require("../models/pullRequestModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getRepositoryRole } = require("../services/repositoryPermissionService");
const { discoverWorkflows } = require("../services/workflowDiscoveryService");
const { cancelRun, enqueueWorkflow, rerunWorkflow, safeRun, TERMINAL } = require("../services/workflowQueueService");
const { REPOSITORY_ROLES } = require("../constants/repositoryPermissions");

function actionError(status, message, code) { return Object.assign(new Error(message), { status, code }); }
const sendError = (res, error) => res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to manage workflows", code: error.code });
const canManage = (repository, userId) => ["owner", "maintainer"].includes(getRepositoryRole(repository, userId));
const isDeploymentManager = (req) => (req.repositoryRole || getRepositoryRole(req.repository, req.user?.id)) === REPOSITORY_ROLES.DEPLOYMENT_MANAGER;
const isTester = (req) => (req.repositoryRole || getRepositoryRole(req.repository, req.user?.id)) === REPOSITORY_ROLES.TESTER;
function assertDeploymentScope(req, workflowOrRun) {
  if (isDeploymentManager(req) && workflowOrRun?.workflowType !== "deployment") throw actionError(403, "Deployment Manager can only manage workflows explicitly marked as deployment workflows", "PERMISSION_DENIED");
  if (isTester(req) && workflowOrRun?.workflowType !== "test") throw actionError(403, "Tester can only trigger workflows explicitly marked as test workflows", "PERMISSION_DENIED");
}
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function parsePagination(query = {}) { const page = Math.max(1, Number.parseInt(query.page, 10) || 1); const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 20)); return { page, limit, skip: (page - 1) * limit }; }
function publicCanSeeActive(req) { return Boolean(getRepositoryRole(req.repository, req.user?.id)); }
function populatedRun(query, includeDefinition = false) {
  if (includeDefinition) query = query.select("+definitionSnapshot +jobs.steps.logKey");
  return query.populate("actor", "_id username name avatarUrl");
}
async function findRun(req, includeDefinition = false) {
  if (!mongoose.Types.ObjectId.isValid(req.params.runId)) throw actionError(400, "Invalid workflow run ID", "RUN_NOT_FOUND");
  const run = await populatedRun(WorkflowRun.findOne({ _id: req.params.runId, repository: req.repository._id }), includeDefinition);
  if (!run || (!publicCanSeeActive(req) && !TERMINAL.has(run.status))) throw actionError(404, "Workflow run not found", "RUN_NOT_FOUND");
  return run;
}
async function workflows(req, res) {
  try {
    const items = await WorkflowDefinition.find({ repository: req.repository._id }).sort({ enabled: -1, name: 1 }).select("-parsedDefinition").lean();
    const scoped = isDeploymentManager(req) ? "deployment" : (isTester(req) ? "test" : null);
    return res.json({ workflows: items.map((item) => { const canTrigger = canManage(req.repository, req.user?.id) || Boolean(scoped && item.workflowType === scoped); return { ...item, canTrigger, enabled: canTrigger ? item.enabled : false }; }), canManage: canManage(req.repository, req.user?.id) || Boolean(scoped) });
  } catch (error) { return sendError(res, error); }
}
async function runs(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { repository: req.repository._id };
    if (!publicCanSeeActive(req)) filter.status = { $in: [...TERMINAL] };
    else if (req.query.status && req.query.status !== "all") {
      if (!["queued", "running", ...TERMINAL].includes(req.query.status)) throw actionError(400, "Invalid workflow status", "WORKFLOW_INVALID");
      filter.status = req.query.status;
    }
    if (req.query.branch) filter.branch = String(req.query.branch).slice(0, 250);
    if (req.query.event) filter.trigger = String(req.query.event);
    if (req.query.workflow && mongoose.Types.ObjectId.isValid(req.query.workflow)) filter.workflow = req.query.workflow;
    if (req.query.search) filter.$or = ["workflowName", "commitMessage", "branch"].map((field) => ({ [field]: { $regex: escapeRegex(String(req.query.search).slice(0, 100)), $options: "i" } }));
    const [items, total, counts] = await Promise.all([
      populatedRun(WorkflowRun.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)).lean(),
      WorkflowRun.countDocuments(filter),
      WorkflowRun.aggregate([{ $match: { repository: req.repository._id, ...(!publicCanSeeActive(req) ? { status: { $in: [...TERMINAL] } } : {}) } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);
    return res.json({ runs: items.map(safeRun), pagination: { page, limit, total, pages: Math.ceil(total / limit) }, counts: Object.fromEntries(counts.map((row) => [row._id, row.count])), canManage: canManage(req.repository, req.user?.id) || isDeploymentManager(req) || isTester(req) });
  } catch (error) { return sendError(res, error); }
}
async function details(req, res) {
  try {
    const run = await findRun(req);
    const checks = await CheckRun.find({ workflowRun: run._id }).sort({ name: 1 }).lean();
    return res.json({ run: safeRun(run), checks, canManage: canManage(req.repository, req.user?.id), runnerMode: "mock" });
  } catch (error) { return sendError(res, error); }
}
async function logs(req, res) {
  try {
    const run = await findRun(req);
    return res.json({ runId: run._id, logs: (run.jobs || []).map((job) => ({ jobId: job._id, name: job.name, steps: (job.steps || []).map((step) => ({ stepId: step._id, name: step.name, status: step.status, log: step.logPreview || "" })) })) });
  } catch (error) { return sendError(res, error); }
}
async function dispatch(req, res) {
  try {
    if (!canManage(req.repository, req.user?.id) && !isDeploymentManager(req) && !isTester(req)) throw actionError(403, "Workflow management permission is required", "PERMISSION_DENIED");
    if (!mongoose.Types.ObjectId.isValid(req.params.workflowId)) throw actionError(400, "Invalid workflow ID", "WORKFLOW_NOT_FOUND");
    const branchName = String(req.body?.branch || req.repository.defaultBranch || "main");
    const branch = (req.repository.branches || []).find((item) => item.name === branchName);
    if (!branch?.head) throw actionError(404, "Branch head not found", "COMMIT_NOT_FOUND");
    const discovered = await discoverWorkflows({ repository: req.repository, commitHash: branch.head, storage: s3, bucket: S3_BUCKET });
    const workflow = discovered.find((item) => String(item._id) === req.params.workflowId || item.path === req.body?.workflowPath);
    if (!workflow) throw actionError(404, "Workflow was not found at this branch head", "WORKFLOW_NOT_FOUND");
    assertDeploymentScope(req, workflow);
    if (workflow.validationStatus !== "valid") throw actionError(400, "Workflow is invalid", "WORKFLOW_INVALID");
    if (!workflow.triggers.includes("workflow_dispatch")) throw actionError(409, "Workflow does not support manual dispatch", "WORKFLOW_DISABLED");
    const commit = (req.repository.commits || []).find((item) => String(item.hash || item._id) === String(branch.head));
    const run = await enqueueWorkflow({ repository: req.repository, workflow, trigger: "workflow_dispatch", branch: branchName, commitHash: String(branch.head), commitMessage: commit?.message || "", actor: req.user.id, eventKey: `${req.repository._id}:${workflow._id}:workflow_dispatch:${branch.head}:${Date.now()}` });
    return res.status(201).json({ message: "Workflow queued", run: safeRun(run) });
  } catch (error) { return sendError(res, error); }
}
async function cancel(req, res) {
  try {
    if (!canManage(req.repository, req.user?.id) && !isDeploymentManager(req)) throw actionError(403, "Workflow management permission is required", "PERMISSION_DENIED");
    const target = await findRun(req, true); assertDeploymentScope(req, target);
    const result = await cancelRun(target);
    return res.json({ message: result.idempotent ? "Workflow was already completed" : "Cancellation requested", idempotent: result.idempotent, run: safeRun(result.run) });
  } catch (error) { return sendError(res, error); }
}
async function rerun(req, res) {
  try {
    if (!canManage(req.repository, req.user?.id)) throw actionError(403, "Owner or maintainer access is required", "PERMISSION_DENIED");
    const run = await rerunWorkflow(await findRun(req, true), req.user.id);
    return res.status(201).json({ message: "Workflow rerun queued", run: safeRun(run) });
  } catch (error) { return sendError(res, error); }
}
async function pullChecks(req, res) {
  try {
    const pull = await PullRequest.findOne({ repository: req.repository._id, number: Number(req.params.number) }).select("_id compareBranch").lean();
    if (!pull) throw actionError(404, "Pull request not found", "RUN_NOT_FOUND");
    const head = (req.repository.branches || []).find((item) => item.name === pull.compareBranch)?.head || null;
    const checks = await CheckRun.find({ pullRequest: pull._id }).sort({ createdAt: -1 }).lean();
    const current = checks.filter((check) => check.commitHash === head); const latest = new Map();
    current.forEach((check) => { if (!latest.has(check.name)) latest.set(check.name, check); });
    const items = [...latest.values()];
    return res.json({ head, checks: items, outdatedCount: checks.length - items.length, summary: { success: items.filter((x) => x.conclusion === "success").length, failure: items.filter((x) => x.conclusion && x.conclusion !== "success").length, pending: items.filter((x) => x.status !== "completed").length } });
  } catch (error) { return sendError(res, error); }
}

module.exports = { cancel, details, dispatch, findRun, logs, parsePagination, pullChecks, rerun, runs, workflows };
