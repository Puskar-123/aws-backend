const { validateBranchName } = require("../utils/branches");
const { BOOLEAN_FIELDS, getProtectionSummary } = require("../services/branchProtectionService");

function safeRule(rule) {
  const value = rule?.toObject ? rule.toObject() : rule;
  return {
    branch: value.branch, enabled: value.enabled !== false,
    rules: Object.fromEntries([...BOOLEAN_FIELDS.filter((field) => field !== "enabled").map((field) => [field, Boolean(value[field])]), ["requiredApprovals", value.requiredApprovals]]),
    createdAt: value.createdAt || null, updatedAt: value.updatedAt || null,
  };
}

function validatedInput(body, { requireBranch = true } = {}) {
  const input = {};
  if (requireBranch || body.branch !== undefined) input.branch = validateBranchName(body.branch);
  if (body.requireResolvedConversations === true) {
    throw Object.assign(new Error("Resolved-conversation protection is not available until review threads are supported"), { status: 400 });
  }
  if (body.requiredApprovals !== undefined) {
    const count = Number(body.requiredApprovals);
    if (!Number.isInteger(count) || count < 0 || count > 10) throw Object.assign(new Error("Required approvals must be an integer from 0 to 10"), { status: 400 });
    input.requiredApprovals = count;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "boolean") throw Object.assign(new Error(`${field} must be a boolean`), { status: 400 });
    input[field] = body[field];
  }
  return input;
}

const send = (res, error) => res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to manage branch protection" });

async function list(req, res) {
  return res.json({ protections: (req.repository.branchProtections || []).map(safeRule), canManage: true });
}

async function create(req, res) {
  try {
    const input = validatedInput(req.body || {});
    if (!(req.repository.branches || []).some((branch) => branch.name === input.branch)) return res.status(404).json({ error: `Branch '${input.branch}' does not exist` });
    if ((req.repository.branchProtections || []).some((rule) => rule.branch === input.branch)) return res.status(409).json({ error: `Protection for branch '${input.branch}' already exists` });
    req.repository.branchProtections.push({ ...input, createdBy: req.user.id, updatedBy: req.user.id });
    await req.repository.save();
    return res.status(201).json({ message: "Branch protection created", protection: safeRule(req.repository.branchProtections.at(-1)) });
  } catch (error) { return send(res, error); }
}

async function update(req, res) {
  try {
    const branch = validateBranchName(decodeURIComponent(req.params.branch));
    const rule = (req.repository.branchProtections || []).find((item) => item.branch === branch);
    if (!rule) return res.status(404).json({ error: "Branch protection not found" });
    const input = validatedInput(req.body || {}, { requireBranch: false });
    delete input.branch;
    Object.assign(rule, input, { updatedBy: req.user.id });
    await req.repository.save();
    return res.json({ message: "Branch protection updated", protection: safeRule(rule) });
  } catch (error) { return send(res, error); }
}

async function remove(req, res) {
  try {
    const branch = validateBranchName(decodeURIComponent(req.params.branch));
    const before = (req.repository.branchProtections || []).length;
    req.repository.branchProtections = (req.repository.branchProtections || []).filter((rule) => rule.branch !== branch);
    if (req.repository.branchProtections.length === before) return res.status(404).json({ error: "Branch protection not found" });
    await req.repository.save();
    return res.json({ message: "Branch protection removed" });
  } catch (error) { return send(res, error); }
}

module.exports = { list, create, update, remove, safeRule, validatedInput };
