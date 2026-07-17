const PullRequest = require("../models/pullRequestModel");
const WorkflowRun = require("../models/workflowRunModel");
const TestResult = require("../models/pullRequestTestResultModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { getBranchSnapshot, branchByName } = require("./branchService");
const { classifyChanges, isProtectedDiffPath } = require("./diffService");

const status = (key, passed, message, pending = false) => ({ key, status: pending ? "pending" : passed ? "passed" : "warning", message });
function changedFiles(repository, baseBranch, branchName) {
  const base = getBranchSnapshot(repository, baseBranch), current = getBranchSnapshot(repository, branchName);
  if (!base || !current) return [];
  const map = rows => new Map(rows.map(file => [file.path, file]));
  return classifyChanges(map(base.files), map(current.files)).map(change => ({ path: change.current?.path || change.previous?.path, status: change.status, file: change.current || change.previous }));
}

async function validateSessionEvidence(session, repository, issue, { PullModel = PullRequest, WorkflowModel = WorkflowRun, TestResultModel = TestResult, storage = s3, bucket = S3_BUCKET } = {}) {
  const changed = changedFiles(repository, session.baseBranch, session.branchName), paths = changed.map(value => value.path), branch = branchByName(repository, session.branchName);
  const commit = branch?.head && String(branch.head) !== String(branchByName(repository, session.baseBranch)?.head || "") ? String(branch.head) : session.commitId || null;
  const pull = await PullModel.findOne({ repository: repository._id, compareBranch: session.branchName });
  const workflow = commit ? await WorkflowModel.findOne({ repository: repository._id, branch: session.branchName, commitHash: commit, status: "success" }).lean() : null;
  const testResult = pull ? await TestResultModel.findOne({ repository: repository._id, pullRequest: pull._id, status: "passed" }).lean() : null;
  const checks = [], contentCache = new Map();
  const contentFor = async change => {
    if (!change) return null;
    if (contentCache.has(change.path)) return contentCache.get(change.path);
    let content = typeof change.file?.content === "string" ? change.file.content : null;
    const key = change.file?.s3Key || change.file?.storageKey;
    if (content == null && key && storage && bucket && Number(change.file?.size || 0) <= 1024 * 1024) {
      try {
        const object = await storage.getObject({ Bucket: bucket, Key: key }).promise(), body = Buffer.from(object.Body || "");
        content = body.length <= 1024 * 1024 && !body.includes(0) ? body.toString("utf8") : null;
      } catch { content = null; }
    }
    contentCache.set(change.path, content); return content;
  };
  checks.push(status("branch_exists", Boolean(branch), branch ? `Branch ${session.branchName} exists.` : "Contribution branch does not exist."));
  for (const check of issue.contributionGuide?.completionChecks || []) {
    const config = check.configuration || {}; let passed = false, pending = false, message = "";
    switch (check.checkType) {
      case "branch_exists": passed = Boolean(branch); message = passed ? "Contribution branch exists." : "Contribution branch is missing."; break;
      case "file_modified": passed = paths.includes(config.path); message = passed ? `${config.path} was modified.` : `${config.path} has not been modified.`; break;
      case "file_not_modified": passed = !paths.includes(config.path); message = passed ? `${config.path} was not modified.` : `${config.path} was unexpectedly modified.`; break;
      case "path_pattern_modified": { let regex; try { regex = new RegExp(String(config.pattern || "").slice(0, 200)); } catch { regex = null; } passed = Boolean(regex && paths.some(value => regex.test(value))); message = passed ? "A matching path was modified." : "No modified path matches the configured pattern."; break; }
      case "minimum_changed_files": passed = paths.length >= Number(config.count || 1); message = `${paths.length} changed file(s) detected.`; break;
      case "maximum_changed_files": passed = paths.length <= Number(config.count || 10); message = `${paths.length} changed file(s) detected.`; break;
      case "commit_exists": passed = Boolean(commit); message = passed ? "A real branch commit exists." : "No branch commit exists."; break;
      case "pull_request_exists": passed = Boolean(pull); message = passed ? "A pull request exists." : "No pull request exists."; break;
      case "workflow_passed": passed = Boolean(workflow); pending = !workflow; message = passed ? "A stored workflow run passed." : "No passing workflow result is available."; break;
      case "test_result_available": passed = Boolean(testResult || workflow); pending = !passed; message = passed ? "Stored testing evidence is available." : "No testing evidence is available."; break;
      case "user_confirmation": passed = Boolean(session.userConfirmations?.get?.(check.key) || session.userConfirmations?.[check.key]); pending = !passed; message = passed ? "Confirmed by the contributor." : "Contributor confirmation is pending."; break;
      case "maintainer_confirmation": passed = Boolean(session.progressItems?.find(value => value.key === check.key && value.status === "completed")); pending = !passed; message = passed ? "Confirmed by a maintainer." : "Maintainer confirmation is pending."; break;
      case "no_protected_file_modified": passed = !paths.some(isProtectedDiffPath); message = passed ? "No protected files were modified." : "A protected file was modified."; break;
      case "no_backend_file_modified": passed = !paths.some(value => /^backend(?:-main)?\//i.test(value)); message = passed ? "No backend files were modified." : "Backend files were modified."; break;
      case "no_frontend_file_modified": passed = !paths.some(value => /^frontend(?:-main)?\//i.test(value)); message = passed ? "No frontend files were modified." : "Frontend files were modified."; break;
      case "css_media_query_present": { const contents = await Promise.all(changed.filter(value => /\.css$/i.test(value.path)).map(contentFor)); passed = contents.some(value => typeof value === "string" && /@media\s*(?:\([^)]*\)|[^{\s]+)/i.test(value)); pending = !passed; message = passed ? "A CSS media query was detected in stored file evidence." : "A media query could not be verified from readable stored file evidence."; break; }
      case "text_pattern_present": { const candidates = config.path ? changed.filter(value => value.path === config.path) : changed, contents = await Promise.all(candidates.map(contentFor)), pattern = String(config.pattern || "").slice(0, 500); passed = Boolean(pattern) && contents.some(value => typeof value === "string" && value.includes(pattern)); pending = !passed; message = passed ? "The configured text pattern was detected in stored file evidence." : "The configured text pattern was not available in readable stored file evidence."; break; }
      default: pending = true; message = "Unsupported check was not executed.";
    }
    checks.push({ ...status(check.key, passed, message, pending), required: check.required !== false, checkType: check.checkType });
  }
  return { status: checks.some(value => value.required && value.status === "warning") ? "needs_attention" : checks.some(value => value.status === "pending") ? "in_progress" : "checks_passed", checks, changedFiles: changed.map(({ path, status: fileStatus }) => ({ path, status: fileStatus })), branchExists: Boolean(branch), commitId: commit, pullRequest: pull?._id || null, workflowPassed: Boolean(workflow), testingEvidence: Boolean(testResult || workflow) };
}
module.exports = { changedFiles, validateSessionEvidence };
