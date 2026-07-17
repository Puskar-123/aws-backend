const WorkflowRun = require("../models/workflowRunModel");
const CheckRun = require("../models/checkRunModel");
const WorkflowDefinition = require("../models/workflowDefinitionModel");
const { safeNotifyRepositoryWatchers } = require("./notificationService");

const TERMINAL = new Set(["success", "failure", "cancelled", "timed_out"]);
const ACTIVE = ["queued", "running"];
const MAX_QUEUED_PER_REPOSITORY = Number(process.env.CODEHUB_CI_MAX_QUEUED_PER_REPOSITORY || 50);
const MAX_ACTIVE_PER_REPOSITORY = Number(process.env.CODEHUB_CI_REPOSITORY_CONCURRENCY || 2);
const MAX_ACTIVE_PER_ACTOR = Number(process.env.CODEHUB_CI_USER_CONCURRENCY || 2);
function queueError(status, message, code) { return Object.assign(new Error(message), { status, code }); }
const idOf = (value) => String(value?._id || value?.id || value || "");
function buildJobs(definition) {
  return Object.entries(definition.jobs || {}).map(([key, job]) => ({
    key, name: job.name || key, runner: job.runner, timeoutMinutes: job.timeoutMinutes, status: "queued",
    steps: job.steps.map((step) => ({ name: step.name, command: step.run, workingDirectory: step.workingDirectory || "", status: "queued" })),
  }));
}
function safeRun(run) {
  const value = run?.toObject ? run.toObject() : { ...run };
  delete value.definitionSnapshot;
  return value;
}
async function enforceQueueLimits(repositoryId, actor, { RunModel = WorkflowRun } = {}) {
  const [queued, repositoryActive, actorActive] = await Promise.all([
    RunModel.countDocuments({ repository: repositoryId, status: "queued" }),
    RunModel.countDocuments({ repository: repositoryId, status: { $in: ACTIVE } }),
    RunModel.countDocuments({ actor, status: { $in: ACTIVE } }),
  ]);
  if (queued >= MAX_QUEUED_PER_REPOSITORY) throw queueError(429, "Repository workflow queue limit reached", "QUEUE_LIMIT_EXCEEDED");
  if (repositoryActive >= MAX_ACTIVE_PER_REPOSITORY || actorActive >= MAX_ACTIVE_PER_ACTOR) throw queueError(429, "Workflow concurrency limit reached", "CONCURRENCY_LIMIT_EXCEEDED");
}
async function createCheckRuns(run, { CheckModel = CheckRun } = {}) {
  if (!run.pullRequest) return [];
  return CheckModel.insertMany((run.jobs || []).map((job) => ({
    repository: run.repository, commitHash: run.commitHash, pullRequest: run.pullRequest, workflowRun: run._id,
    name: `${run.workflowName} / ${job.name}`, status: "queued", conclusion: null,
    detailsUrl: `/repo/${run.repository}/actions/runs/${run._id}`,
  })), { ordered: false });
}
async function enqueueWorkflow({ repository, workflow, trigger, branch, commitHash, commitMessage = "", pullRequest = null, actor, eventKey, attempt = 1, previousRun = null }, dependencies = {}) {
  const RunModel = dependencies.RunModel || WorkflowRun;
  await enforceQueueLimits(repository._id || repository, actor, { RunModel });
  try {
    const run = await RunModel.create({
      repository: repository._id || repository, workflow: workflow._id, workflowPath: workflow.path,
      workflowName: workflow.name, workflowType: workflow.workflowType || "standard", definitionSnapshot: workflow.parsedDefinition, trigger, branch, commitHash,
      commitMessage, pullRequest, actor, attempt, previousRun, eventKey, jobs: buildJobs(workflow.parsedDefinition),
    });
    await createCheckRuns(run, dependencies);
    return run;
  } catch (error) {
    if (error?.code === 11000) return RunModel.findOne({ eventKey });
    throw error;
  }
}
async function queueForEvent({ repository, workflows, trigger, branch, commitHash, commitMessage, pullRequest, actor }, dependencies = {}) {
  const matching = workflows.filter((workflow) => workflow.enabled !== false && workflow.validationStatus === "valid" && workflow.triggers?.includes(trigger));
  const runs = [];
  for (const workflow of matching) {
    const key = `${idOf(repository)}:${idOf(workflow)}:${trigger}:${commitHash}:${idOf(pullRequest) || "none"}`;
    try { runs.push(await enqueueWorkflow({ repository, workflow, trigger, branch, commitHash, commitMessage, pullRequest, actor, eventKey: key }, dependencies)); }
    catch (error) { if (!["QUEUE_LIMIT_EXCEEDED", "CONCURRENCY_LIMIT_EXCEEDED"].includes(error.code)) throw error; }
  }
  return runs;
}
async function claimNextRun(runnerId, { RunModel = WorkflowRun, CheckModel = CheckRun } = {}) {
  const run = await RunModel.findOneAndUpdate(
    { status: "queued", cancellationRequested: false },
    { $set: { status: "running", runnerId: String(runnerId).slice(0, 200), startedAt: new Date() }, $inc: { infrastructureAttempts: 1 } },
    { new: true, sort: { queuedAt: 1, _id: 1 } },
  ).select("+definitionSnapshot");
  if (run) await CheckModel.updateMany({ workflowRun: run._id }, { $set: { status: "in_progress", startedAt: run.startedAt } });
  return run;
}
async function updateChecks(run, { CheckModel = CheckRun } = {}) {
  const conclusion = TERMINAL.has(run.status) ? run.status : null;
  const status = conclusion ? "completed" : (run.status === "running" ? "in_progress" : "queued");
  await Promise.all((run.jobs || []).map((job) => CheckModel.updateOne(
    { workflowRun: run._id, name: `${run.workflowName} / ${job.name}` },
    { $set: { status, conclusion: conclusion === "success" ? "success" : conclusion, startedAt: run.startedAt, completedAt: run.completedAt } },
  )));
}
function sanitizeLog(value, secrets = []) {
  let text = String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  for (const secret of secrets.filter((item) => String(item || "").length >= 6)) text = text.split(String(secret)).join("[REDACTED]");
  text = text
    .replace(/\b(authorization)\s*[=:]\s*(?:Bearer\s+)?\S+/gi, "$1=[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|MONGODB_URI|DATABASE_URL|AWS_ACCESS_KEY_ID)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[REDACTED]");
  return text.split(/\r?\n/).map((line) => line.slice(0, 2000)).join("\n").slice(0, 20000);
}
async function finishRun(run, status, { CheckModel = CheckRun, RunModel = WorkflowRun, notify = safeNotifyRepositoryWatchers, repository = null } = {}) {
  const now = new Date(); run.status = status; run.completedAt = now; run.durationMs = run.startedAt ? now - run.startedAt : 0;
  await run.save(); await updateChecks(run, { CheckModel });
  if (status === "failure" && repository) await notify(repository, {
    actor: run.actor, type: "workflow_failed", title: `${run.workflowName} failed`,
    message: `${run.workflowName} failed on ${run.branch}`, url: `/repo/${run.repository}/actions/runs/${run._id}`,
    eventKey: `workflow-failed:${run._id}`, metadata: { workflowRun: run._id, commit: run.commitHash, branch: run.branch },
  });
  if (status === "success" && repository) {
    const previousFailure = await RunModel.findOne({ _id: { $ne: run._id }, repository: run.repository, workflow: run.workflow, branch: run.branch, status: "failure", createdAt: { $lt: run.createdAt || now } }).sort({ createdAt: -1 }).select("_id createdAt").lean();
    const laterSuccess = previousFailure && await RunModel.exists({ _id: { $ne: run._id }, repository: run.repository, workflow: run.workflow, branch: run.branch, status: "success", createdAt: { $gt: previousFailure.createdAt, $lt: run.createdAt || now } });
    if (previousFailure && !laterSuccess) await notify(repository, {
      actor: run.actor, type: "workflow_recovered", title: `${run.workflowName} recovered`,
      message: `${run.workflowName} succeeded after a previous failure on ${run.branch}`, url: `/repo/${run.repository}/actions/runs/${run._id}`,
      eventKey: `workflow-recovered:${run._id}`, metadata: { workflowRun: run._id, previousRun: previousFailure._id, commit: run.commitHash, branch: run.branch },
    });
  }
  return run;
}
async function cancelRun(run, dependencies = {}) {
  if (TERMINAL.has(run.status)) return { run, idempotent: true };
  if (run.status === "queued") {
    run.status = "cancelled"; run.cancellationRequested = true; run.completedAt = new Date(); run.durationMs = 0;
    for (const job of run.jobs || []) { job.status = "cancelled"; for (const step of job.steps || []) step.status = "cancelled"; }
    await run.save(); await updateChecks(run, dependencies); return { run, idempotent: false };
  }
  run.cancellationRequested = true; await run.save(); return { run, idempotent: false };
}
async function rerunWorkflow(run, actor, { RunModel = WorkflowRun, WorkflowModel = WorkflowDefinition, ...dependencies } = {}) {
  if (!TERMINAL.has(run.status)) throw queueError(409, "Only completed workflow runs may be rerun", "RUN_ALREADY_COMPLETED");
  const workflow = await WorkflowModel.findById(run.workflow);
  if (!workflow) throw queueError(404, "Workflow definition not found", "WORKFLOW_NOT_FOUND");
  workflow.parsedDefinition = run.definitionSnapshot || workflow.parsedDefinition;
  return enqueueWorkflow({ repository: run.repository, workflow, trigger: run.trigger, branch: run.branch, commitHash: run.commitHash, commitMessage: run.commitMessage, pullRequest: run.pullRequest, actor, attempt: run.attempt + 1, previousRun: run._id, eventKey: `${run.eventKey}:rerun:${run.attempt + 1}` }, { RunModel, ...dependencies });
}

module.exports = { ACTIVE, TERMINAL, buildJobs, cancelRun, claimNextRun, createCheckRuns, enforceQueueLimits, enqueueWorkflow, finishRun, queueError, queueForEvent, rerunWorkflow, safeRun, sanitizeLog, updateChecks };
