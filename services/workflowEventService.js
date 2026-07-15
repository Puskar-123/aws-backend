const PullRequest = require("../models/pullRequestModel");
const Repository = require("../models/repoModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { discoverWorkflows } = require("./workflowDiscoveryService");
const { queueForEvent } = require("./workflowQueueService");

function commitMessage(repository, hash) {
  const commit = (repository.commits || []).find((item) => String(item.hash || item._id) === String(hash));
  return commit?.message || "";
}
async function scheduleCommitWorkflows(repository, { branch, commitHash, actor, triggerPush = true, PullModel = PullRequest, storage = s3, bucket = S3_BUCKET } = {}) {
  if (!repository || !commitHash || !branch || !actor) return [];
  const workflows = await discoverWorkflows({ repository, commitHash, storage, bucket });
  const message = commitMessage(repository, commitHash);
  const runs = [];
  if (triggerPush) runs.push(...await queueForEvent({ repository, workflows, trigger: "push", branch, commitHash, commitMessage: message, actor }));
  const pulls = await PullModel.find({ repository: repository._id, compareBranch: branch, status: "open" }).select("_id number").lean();
  for (const pull of pulls) runs.push(...await queueForEvent({ repository, workflows, trigger: "pull_request", branch, commitHash, commitMessage: message, pullRequest: pull._id, actor }));
  return runs;
}
async function schedulePullRequestWorkflows(repository, pullRequest, actor, dependencies = {}) {
  const commitHash = (repository.branches || []).find((branch) => branch.name === pullRequest.compareBranch)?.head;
  if (!commitHash) return [];
  const storage = dependencies.storage || s3; const bucket = dependencies.bucket || S3_BUCKET;
  const workflows = await discoverWorkflows({ repository, commitHash, storage, bucket });
  return queueForEvent({ repository, workflows, trigger: "pull_request", branch: pullRequest.compareBranch, commitHash, commitMessage: commitMessage(repository, commitHash), pullRequest: pullRequest._id, actor }, dependencies);
}
async function safeScheduleCommitWorkflows(repository, input) {
  if (require("../models/workflowDefinitionModel").db.readyState !== 1) return [];
  try { return await scheduleCommitWorkflows(await Repository.findById(repository._id) || repository, input); }
  catch (error) { console.error(`Workflow scheduling failed for repository ${repository?._id}:`, error.message); return []; }
}
async function safeSchedulePullRequestWorkflows(repository, pullRequest, actor, dependencies) {
  if (require("../models/workflowDefinitionModel").db.readyState !== 1) return [];
  try { return await schedulePullRequestWorkflows(await Repository.findById(repository._id) || repository, pullRequest, actor, dependencies); }
  catch (error) { console.error(`PR workflow scheduling failed for repository ${repository?._id}:`, error.message); return []; }
}

module.exports = { commitMessage, safeScheduleCommitWorkflows, safeSchedulePullRequestWorkflows, scheduleCommitWorkflows, schedulePullRequestWorkflows };
