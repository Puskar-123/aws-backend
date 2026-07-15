const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const WorkflowDefinition = require("../models/workflowDefinitionModel");
const WorkflowRun = require("../models/workflowRunModel");
const CheckRun = require("../models/checkRunModel");
const Repository = require("../models/repoModel");
const { parseWorkflow, LIMITS } = require("../services/workflowParserService");
const { evaluateRequiredStatusChecks, assertRequiredStatusChecks } = require("../services/branchProtectionService");
const { sanitizeLog } = require("../services/workflowQueueService");

const valid = `name: CI\non: [push, pull_request, workflow_dispatch]\njobs:\n  test:\n    name: Unit tests\n    runs-on: node-22\n    timeout-minutes: 5\n    steps:\n      - name: Install\n        run: npm ci\n      - name: Test\n        run: npm test\n        env:\n          NODE_ENV: test\n`;

test("parses the supported workflow subset into a normalized definition", () => {
  const workflow = parseWorkflow(valid, { path: ".codehub/workflows/ci.yml" });
  assert.deepEqual(workflow.triggers, ["push", "pull_request", "workflow_dispatch"]);
  assert.equal(workflow.jobs.test.runner, "node-22");
  assert.equal(workflow.jobs.test.steps[1].env.NODE_ENV, "test");
});

test("rejects unsupported runners, unknown fields, metadata traversal, and secret-like env", () => {
  assert.throws(() => parseWorkflow(valid.replace("node-22", "ubuntu-latest")), { code: "UNSUPPORTED_RUNNER" });
  assert.throws(() => parseWorkflow(valid.replace("    runs-on", "    container: node\n    runs-on")), /unsupported field/);
  assert.throws(() => parseWorkflow(valid.replace("        env:", "        working-directory: .codehub/workflows\n        env:")), /metadata/);
  assert.throws(() => parseWorkflow(valid.replace("NODE_ENV", "API_TOKEN")), /forbidden variable/);
});

test("enforces workflow size and complexity limits", () => {
  assert.throws(() => parseWorkflow("x".repeat(LIMITS.fileBytes + 1)), { code: "WORKFLOW_TOO_LARGE" });
  const tooMany = Array.from({ length: LIMITS.stepsPerJob + 1 }, (_, i) => `      - name: S${i}\n        run: echo ${i}`).join("\n");
  assert.throws(() => parseWorkflow(`name: CI\non: push\njobs:\n  test:\n    runs-on: node-22\n    steps:\n${tooMany}\n`), /at most|between/);
});

test("workflow models expose durable queue, check, and branch-protection fields", () => {
  assert.ok(WorkflowDefinition.schema.path("sourceCommitHash"));
  assert.ok(WorkflowRun.schema.path("eventKey"));
  assert.ok(WorkflowRun.schema.path("cancellationRequested"));
  assert.ok(CheckRun.schema.path("commitHash"));
  assert.ok(Repository.schema.path("branchProtections.requireStatusChecks"));
  assert.ok(Repository.schema.path("branchProtections.requiredStatusChecks"));
});

test("required checks use the latest result for the exact pull request head", async () => {
  const owner = new mongoose.Types.ObjectId();
  const repository = { owner, collaborators: [], branchProtections: [{ branch: "main", enabled: true, requireStatusChecks: true, requiredStatusChecks: ["test", "lint"], allowOwnerBypass: false, allowMaintainerBypass: false }] };
  const pull = { _id: new mongoose.Types.ObjectId(), baseBranch: "main" };
  const CheckModel = { find(query) { assert.equal(query.commitHash, "head-2"); return { sort() { return { lean: async () => [
    { name: "test", status: "completed", conclusion: "success", createdAt: new Date(2) },
    { name: "test", status: "completed", conclusion: "failure", createdAt: new Date(1) },
    { name: "lint", status: "in_progress", conclusion: null, createdAt: new Date(2) },
  ] }; } }; } };
  const result = await evaluateRequiredStatusChecks(repository, pull, "head-2", new mongoose.Types.ObjectId(), { CheckModel });
  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.map((item) => item.state), ["success", "pending"]);
  await assert.rejects(() => assertRequiredStatusChecks(repository, pull, "head-2", new mongoose.Types.ObjectId(), { CheckModel }), { code: "CHECKS_NOT_PASSED", status: 409 });
});

test("mock runner contains no command execution primitive and log sanitizer redacts credentials", () => {
  const source = fs.readFileSync(path.join(__dirname, "../runner/mockWorker.js"), "utf8");
  assert.doesNotMatch(source, /child_process|execFile|\bspawn\s*\(/);
  assert.match(source, /Command execution is disabled/);
  const output = sanitizeLog("Authorization: Bearer abc.def.ghi\nPASSWORD=hunter2\u001b[31m");
  assert.doesNotMatch(output, /abc\.def\.ghi|hunter2|\u001b/);
  assert.match(output, /REDACTED/);
});
