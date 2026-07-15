const WorkflowRun = require("../models/workflowRunModel");
const Repository = require("../models/repoModel");
const { claimNextRun, finishRun, sanitizeLog, updateChecks } = require("../services/workflowQueueService");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function processMockRun(run, { RunModel = WorkflowRun, RepositoryModel = Repository, outcome = process.env.CODEHUB_MOCK_RUNNER_OUTCOME || "success", stepDelayMs = Number(process.env.CODEHUB_MOCK_RUNNER_STEP_DELAY_MS || 25) } = {}) {
  const started = Date.now();
  for (const job of run.jobs || []) {
    job.status = "running"; job.startedAt = new Date();
    for (const step of job.steps || []) {
      const fresh = await RunModel.findById(run._id).select("cancellationRequested").lean();
      if (fresh?.cancellationRequested) {
        step.status = "cancelled"; step.completedAt = new Date();
        for (const pending of job.steps.filter((item) => item.status === "queued")) pending.status = "cancelled";
        job.status = "cancelled"; job.completedAt = new Date(); job.durationMs = job.completedAt - job.startedAt;
        const repository = await RepositoryModel.findById(run.repository);
        return finishRun(run, "cancelled", { repository });
      }
      step.status = "running"; step.startedAt = new Date(); await run.save(); await delay(stepDelayMs);
      const shouldFail = outcome === "failure"; const shouldTimeout = outcome === "timed_out";
      step.status = shouldFail ? "failure" : (shouldTimeout ? "timed_out" : "success");
      step.exitCode = shouldFail ? 1 : (shouldTimeout ? null : 0); step.completedAt = new Date(); step.durationMs = step.completedAt - step.startedAt;
      step.logPreview = sanitizeLog(`[CodeHub mock runner]\nCommand execution is disabled.\nValidated step: ${step.name}\nRequested command: ${step.command}\nMock result: ${step.status}`);
      await run.save();
      if (shouldFail || shouldTimeout) {
        for (const pending of job.steps.filter((item) => item.status === "queued")) pending.status = "cancelled";
        job.status = step.status; job.completedAt = new Date(); job.durationMs = job.completedAt - job.startedAt;
        const repository = await RepositoryModel.findById(run.repository);
        return finishRun(run, step.status, { repository });
      }
    }
    job.status = "success"; job.completedAt = new Date(); job.durationMs = job.completedAt - job.startedAt; await run.save();
  }
  run.durationMs = Date.now() - started;
  const repository = await RepositoryModel.findById(run.repository);
  return finishRun(run, "success", { repository });
}
async function pollOnce(runnerId, dependencies = {}) {
  const run = await claimNextRun(runnerId, dependencies);
  if (!run) return null;
  try { return await processMockRun(run, dependencies); }
  catch (error) {
    run.status = "failure"; run.completedAt = new Date();
    for (const job of run.jobs || []) if (!["success", "failure"].includes(job.status)) job.status = "failure";
    await run.save(); await updateChecks(run, dependencies); throw error;
  }
}

module.exports = { delay, pollOnce, processMockRun };
