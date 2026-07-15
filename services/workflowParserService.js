const YAML = require("yaml");
const { normalizeRepoPath } = require("../utils/repoPath");

const LIMITS = { fileBytes: 100 * 1024, jobs: 10, stepsPerJob: 30, commandLength: 4000, envPerStep: 20, jobTimeoutMinutes: 30, workflowTimeoutMinutes: 60 };
const TRIGGERS = new Set(["push", "pull_request", "workflow_dispatch", "release"]);
const RUNNERS = new Set(["node-22"]);
const forbiddenEnvName = /(secret|token|password|passwd|credential|private|jwt|mongo|database|aws|cookie)/i;
function workflowError(message, code = "WORKFLOW_INVALID", status = 400) { return Object.assign(new Error(message), { code, status }); }
function ownKeys(value) { return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []; }
function rejectUnknown(value, allowed, path) {
  const unknown = ownKeys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw workflowError(`${path} contains unsupported field '${unknown[0]}'`);
}
function parseTriggers(value) {
  const triggers = Array.isArray(value) ? value : [value];
  if (!triggers.length || triggers.some((item) => typeof item !== "string" || !TRIGGERS.has(item))) throw workflowError("on must contain only push, pull_request, workflow_dispatch, or release");
  return [...new Set(triggers)];
}
function safeWorkingDirectory(value) {
  if (value === undefined || value === null || value === "") return "";
  const directory = normalizeRepoPath(String(value));
  if (directory.startsWith(".codehub/") || directory === ".codehub") throw workflowError("working-directory cannot access CodeHub metadata");
  return directory;
}
function safeEnvironment(value, path) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw workflowError(`${path}.env must be an object`);
  const entries = Object.entries(value);
  if (entries.length > LIMITS.envPerStep) throw workflowError(`${path}.env may contain at most ${LIMITS.envPerStep} values`);
  return Object.fromEntries(entries.map(([key, raw]) => {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/i.test(key) || forbiddenEnvName.test(key)) throw workflowError(`${path}.env contains a forbidden variable name`);
    if (!["string", "number", "boolean"].includes(typeof raw) || String(raw).length > 500) throw workflowError(`${path}.env.${key} must be a short scalar value`);
    return [key, String(raw)];
  }));
}
function parseWorkflow(source, { path = "workflow.yml" } = {}) {
  const bytes = Buffer.byteLength(String(source || ""), "utf8");
  if (!bytes || bytes > LIMITS.fileBytes) throw workflowError(`Workflow file must be between 1 byte and ${LIMITS.fileBytes} bytes`, bytes > LIMITS.fileBytes ? "WORKFLOW_TOO_LARGE" : "WORKFLOW_INVALID", bytes > LIMITS.fileBytes ? 413 : 400);
  if (/(^|[\s:[,{])!(?:<|[A-Za-z_])/m.test(source)) throw workflowError("Custom YAML tags are not supported");
  const document = YAML.parseDocument(source, { prettyErrors: true, strict: true, uniqueKeys: true });
  if (document.errors.length) throw workflowError(`Invalid YAML in ${path}: ${document.errors[0].message}`);
  let input;
  try { input = document.toJS({ maxAliasCount: 20 }); } catch (error) { throw workflowError(`Invalid YAML in ${path}: ${error.message}`); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw workflowError("Workflow root must be an object");
  rejectUnknown(input, ["name", "on", "jobs"], "workflow");
  const name = String(input.name || "").trim();
  if (!name || name.length > 200) throw workflowError("name must contain 1 to 200 characters");
  const triggers = parseTriggers(input.on);
  if (!input.jobs || typeof input.jobs !== "object" || Array.isArray(input.jobs)) throw workflowError("jobs must be an object");
  const jobEntries = Object.entries(input.jobs);
  if (!jobEntries.length || jobEntries.length > LIMITS.jobs) throw workflowError(`Workflow must contain between 1 and ${LIMITS.jobs} jobs`);
  let totalTimeout = 0;
  const jobs = {};
  for (const [key, job] of jobEntries) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(key) || !job || typeof job !== "object" || Array.isArray(job)) throw workflowError(`Invalid job '${key}'`);
    rejectUnknown(job, ["name", "runs-on", "timeout-minutes", "steps"], `jobs.${key}`);
    const runner = String(job["runs-on"] || "");
    if (!RUNNERS.has(runner)) throw workflowError(`Unsupported runner: ${runner || "missing"}`, "UNSUPPORTED_RUNNER");
    const timeoutMinutes = Number(job["timeout-minutes"] || 10);
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > LIMITS.jobTimeoutMinutes) throw workflowError(`jobs.${key}.timeout-minutes must be between 1 and ${LIMITS.jobTimeoutMinutes}`);
    totalTimeout += timeoutMinutes;
    if (totalTimeout > LIMITS.workflowTimeoutMinutes) throw workflowError(`Workflow timeout may not exceed ${LIMITS.workflowTimeoutMinutes} minutes`);
    if (!Array.isArray(job.steps) || !job.steps.length || job.steps.length > LIMITS.stepsPerJob) throw workflowError(`jobs.${key}.steps must contain between 1 and ${LIMITS.stepsPerJob} steps`);
    const steps = job.steps.map((step, index) => {
      const stepPath = `jobs.${key}.steps[${index}]`;
      if (!step || typeof step !== "object" || Array.isArray(step)) throw workflowError(`${stepPath} must be an object`);
      rejectUnknown(step, ["name", "run", "working-directory", "env"], stepPath);
      const stepName = String(step.name || "").trim(); const command = String(step.run || "").trim();
      if (!stepName || stepName.length > 200) throw workflowError(`${stepPath}.name must contain 1 to 200 characters`);
      if (!command || command.length > LIMITS.commandLength || command.includes("\0")) throw workflowError(`${stepPath}.run must contain 1 to ${LIMITS.commandLength} characters`);
      return { name: stepName, run: command, workingDirectory: safeWorkingDirectory(step["working-directory"]), env: safeEnvironment(step.env, stepPath) };
    });
    jobs[key] = { name: String(job.name || key).trim().slice(0, 200), runner, timeoutMinutes, steps };
  }
  return { name, triggers, jobs };
}

module.exports = { LIMITS, RUNNERS, TRIGGERS, parseWorkflow, workflowError };
