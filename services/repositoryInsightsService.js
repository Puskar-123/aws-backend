const path = require("path");
const { LANGUAGES } = require("./repositoryLanguageService");
const { isProtectedDiffPath } = require("./diffService");
const { isDefaultIgnoredRepoPath, normalizeRepoPath } = require("../utils/repoPath");
const { validateBranchName } = require("../utils/branches");

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, "180d": 180, "1y": 365 };
const MAX_CUSTOM_DAYS = 3650;
const idOf = (value) => String(value?._id || value?.id || value || "");
const startOfUtcDay = (value) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));

function insightError(status, message) { return Object.assign(new Error(message), { status }); }
function parseDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) throw insightError(400, `${label} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw insightError(400, `Invalid ${label.toLowerCase()}`);
  return date;
}
function parseRange(query = {}, now = new Date()) {
  const range = String(query.range || "30d");
  let from; let to;
  if (query.from || query.to) {
    if (!query.from || !query.to) throw insightError(400, "Both from and to are required for a custom range");
    from = parseDate(query.from, "From"); to = parseDate(query.to, "To");
    to = new Date(to.getTime() + 86400000 - 1);
    if (from > to) throw insightError(400, "From date must be before to date");
    if ((to - from) / 86400000 > MAX_CUSTOM_DAYS) throw insightError(400, `Custom ranges cannot exceed ${MAX_CUSTOM_DAYS} days`);
    return { key: "custom", from, to, interval: (to - from) / 86400000 <= 31 ? "day" : (to - from) / 86400000 <= 366 ? "week" : "month", timezone: "UTC" };
  }
  if (range !== "all" && !RANGE_DAYS[range]) throw insightError(400, "Range must be 7d, 30d, 90d, 180d, 1y, or all");
  to = now;
  from = range === "all" ? new Date(0) : new Date(startOfUtcDay(now).getTime() - (RANGE_DAYS[range] - 1) * 86400000);
  const interval = ["7d", "30d"].includes(range) ? "day" : (["90d", "180d", "1y"].includes(range) ? "week" : "month");
  return { key: range, from, to, interval, timezone: "UTC" };
}
function parsePagination(query = {}, defaultLimit = 20, maximum = 100) {
  const page = Number.parseInt(query.page, 10) || 1; const limit = Number.parseInt(query.limit, 10) || defaultLimit;
  if (page < 1 || page > 100 || limit < 1) throw insightError(400, "Page must be between 1 and 100 and limit must be positive");
  return { page, limit: Math.min(limit, maximum), skip: (page - 1) * Math.min(limit, maximum) };
}
function dateKey(date, interval) {
  const value = new Date(date);
  if (interval === "day") return value.toISOString().slice(0, 10);
  if (interval === "month") return value.toISOString().slice(0, 7);
  const day = startOfUtcDay(value); const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86400000);
  return monday.toISOString().slice(0, 10);
}
function fillSeries(rows, range) {
  const counts = new Map(rows.map((row) => [String(row._id || row.date), Number(row.count || row.commits || 0)]));
  if (range.key === "all" && rows.length === 0) return [];
  let cursor = range.key === "all" ? new Date(`${String(rows[0]._id).slice(0, 7)}-01T00:00:00Z`) : startOfUtcDay(range.from);
  const end = range.to; const result = [];
  while (cursor <= end && result.length < 600) {
    const key = dateKey(cursor, range.interval); result.push({ date: key, commits: counts.get(key) || 0 });
    if (range.interval === "day") cursor = new Date(cursor.getTime() + 86400000);
    else if (range.interval === "week") cursor = new Date(cursor.getTime() + 7 * 86400000);
    else cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return result;
}
function dateGroupExpression(interval, field = "$commits.time") {
  const format = interval === "day" ? "%Y-%m-%d" : (interval === "month" ? "%Y-%m" : "%G-%V");
  return { $dateToString: { format, date: field, timezone: "UTC" } };
}
function normalizeWeekRows(rows) {
  return rows.map((row) => {
    if (!/^\d{4}-\d{2}$/.test(String(row._id))) return row;
    const [year, week] = String(row._id).split("-").map(Number);
    const jan4 = new Date(Date.UTC(year, 0, 4)); const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (week - 1) * 7 * 86400000);
    return { ...row, _id: monday.toISOString().slice(0, 10) };
  });
}
const commitMatch = (repositoryId, range, branch) => ({ _id: repositoryId, "commits.time": { $gte: range.from, $lte: range.to }, ...(branch ? { "commits.branch": branch } : {}) });

async function getOverview({ Repository, Issue, PullRequest, Tag, Release, WorkflowRun, repository, range }) {
  const [commitRows, issueRows, pullRows, tagCount, releaseRows, workflowRows] = await Promise.all([
    Repository.aggregate([{ $match: { _id: repository._id } }, { $unwind: "$commits" }, { $match: { "commits.time": { $gte: range.from, $lte: range.to } } }, { $group: { _id: null, commits: { $sum: 1 }, contributors: { $addToSet: { $ifNull: ["$commits.author.name", "Unknown contributor"] } } } }]),
    Issue.aggregate([{ $match: { repository: repository._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    PullRequest.aggregate([{ $match: { repository: repository._id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Tag ? Tag.countDocuments({ repository: repository._id }) : 0,
    Release ? Release.aggregate([{ $match: { repository: repository._id, draft: false } }, { $group: { _id: "$prerelease", count: { $sum: 1 } } }]) : [],
    WorkflowRun ? WorkflowRun.aggregate([{ $match: { repository: repository._id, createdAt: { $gte: range.from, $lte: range.to } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]) : [],
  ]);
  const issues = Object.fromEntries(issueRows.map((row) => [row._id, row.count])); const pulls = Object.fromEntries(pullRows.map((row) => [row._id, row.count]));
  const releaseCounts = Object.fromEntries(releaseRows.map((row) => [String(row._id), row.count]));
  const workflowCounts = Object.fromEntries(workflowRows.map((row) => [String(row._id), row.count]));
  return { repository: { _id: repository._id, name: repository.name, owner: repository.owner }, summary: {
    commits: commitRows[0]?.commits || 0, contributors: commitRows[0]?.contributors?.length || 0,
    branches: repository.branches?.length || 0, openIssues: issues.open || 0, closedIssues: issues.closed || 0,
    openPullRequests: pulls.open || 0, closedPullRequests: pulls.closed || 0, mergedPullRequests: pulls.merged || 0,
    stars: repository.stars?.length || 0, forks: repository.forks?.length || 0, watchers: repository.watchers?.length || 0,
    ...(Tag || Release ? { tags: tagCount, releases: (releaseCounts.false || 0) + (releaseCounts.true || 0), prereleases: releaseCounts.true || 0 } : {}),
    ...(WorkflowRun ? { workflowRuns: workflowRows.reduce((sum, row) => sum + row.count, 0), successfulWorkflowRuns: workflowCounts.success || 0, failedWorkflowRuns: workflowCounts.failure || 0 } : {}),
  }, range: range.key, timezone: range.timezone, socialHistoryAvailable: false };
}

async function getWorkflowAnalytics({ WorkflowRun, repository, range }) {
  const rows = await WorkflowRun.aggregate([{ $match: { repository: repository._id, createdAt: { $gte: range.from, $lte: range.to } } }, { $facet: {
    statuses: [{ $group: { _id: "$status", count: { $sum: 1 }, averageDurationMs: { $avg: "$durationMs" } } }],
    series: [{ $group: { _id: dateGroupExpression(range.interval, "$createdAt"), runs: { $sum: 1 }, failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } } } }, { $sort: { _id: 1 } }],
    failing: [{ $match: { status: "failure" } }, { $group: { _id: "$workflowName", failures: { $sum: 1 } } }, { $sort: { failures: -1, _id: 1 } }, { $limit: 1 }],
  } }]);
  const result = rows[0] || { statuses: [], series: [], failing: [] }; const counts = Object.fromEntries(result.statuses.map((row) => [row._id, row.count]));
  const total = result.statuses.reduce((sum, row) => sum + row.count, 0); const completed = (counts.success || 0) + (counts.failure || 0);
  const durations = result.statuses.filter((row) => Number.isFinite(row.averageDurationMs));
  const averageDurationMs = durations.length ? Math.round(durations.reduce((sum, row) => sum + row.averageDurationMs * row.count, 0) / durations.reduce((sum, row) => sum + row.count, 0)) : null;
  return { summary: { total, success: counts.success || 0, failure: counts.failure || 0, cancelled: counts.cancelled || 0, timedOut: counts.timed_out || 0, queued: counts.queued || 0, running: counts.running || 0, successRate: completed ? Number(((counts.success || 0) * 100 / completed).toFixed(1)) : null, averageDurationMs }, series: result.series, mostFrequentlyFailingWorkflow: result.failing[0] ? { name: result.failing[0]._id, failures: result.failing[0].failures } : null, interval: range.interval, range: range.key };
}

async function getCommitActivity({ Repository, repository, range, branch }) {
  const branchName = branch ? validateBranchName(branch) : null;
  let rows = await Repository.aggregate([{ $match: { _id: repository._id } }, { $unwind: "$commits" }, { $match: commitMatch(repository._id, range, branchName) }, { $group: { _id: dateGroupExpression(range.interval), count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  if (range.interval === "week") rows = normalizeWeekRows(rows);
  const series = fillSeries(rows, range); const totalCommits = rows.reduce((total, row) => total + row.count, 0);
  const mostActiveDay = series.reduce((best, point) => !best || point.commits > best.commits ? point : best, null);
  return { interval: range.interval, series, totalCommits, mostActiveDay: mostActiveDay?.commits ? mostActiveDay : null, branch: branchName, range: range.key, timezone: "UTC" };
}

async function getContributors({ Repository, repository, range, query }) {
  const pagination = parsePagination(query);
  const rows = await Repository.aggregate([{ $match: { _id: repository._id } }, { $unwind: "$commits" }, { $match: { "commits.time": { $gte: range.from, $lte: range.to } } }, { $group: {
    _id: { $ifNull: ["$commits.author.name", "Deleted contributor"] }, commits: { $sum: 1 },
    additions: { $sum: { $ifNull: ["$commits.summary.additions", 0] } }, deletions: { $sum: { $ifNull: ["$commits.summary.deletions", 0] } }, filesChanged: { $sum: { $ifNull: ["$commits.summary.filesChanged", 0] } },
    missingSummary: { $sum: { $cond: [{ $eq: [{ $type: "$commits.summary.filesChanged" }, "missing"] }, 1, 0] } }, lastContributionAt: { $max: "$commits.time" },
  } }, { $sort: { commits: -1, _id: 1 } }, { $facet: { items: [{ $skip: pagination.skip }, { $limit: pagination.limit }], total: [{ $count: "count" }] } }]);
  const result = rows[0] || { items: [], total: [] }; const total = result.total[0]?.count || 0;
  return { contributors: result.items.map((item) => ({ user: null, name: item._id, commits: item.commits, additions: item.missingSummary ? null : item.additions, deletions: item.missingSummary ? null : item.deletions, filesChanged: item.missingSummary ? null : item.filesChanged, lastContributionAt: item.lastContributionAt })), pagination: { page: pagination.page, limit: pagination.limit, total, pages: Math.ceil(total / pagination.limit) }, range: range.key };
}

function languageFor(filePath) { return LANGUAGES.get(path.posix.extname(filePath.toLowerCase())) || null; }
function safeAnalyticsPath(filePath) {
  try { const normalized = normalizeRepoPath(filePath); return !isProtectedDiffPath(normalized) && !isDefaultIgnoredRepoPath(normalized); } catch { return false; }
}
async function getLanguages({ Repository, repository, branch }) {
  const branchName = validateBranchName(branch || repository.defaultBranch || "main");
  let files;
  if (branchName === (repository.defaultBranch || "main")) files = (await Repository.findById(repository._id).select("content").lean())?.content || [];
  else {
    const head = repository.branches?.find((item) => item.name === branchName)?.head;
    if (!head) throw insightError(404, `Branch '${branchName}' not found`);
    const rows = await Repository.aggregate([{ $match: { _id: repository._id } }, { $unwind: "$commits" }, { $match: { "commits.hash": head } }, { $project: { files: { $cond: [{ $gt: [{ $size: { $ifNull: ["$commits.snapshot", []] } }, 0] }, "$commits.snapshot", "$commits.files"] } } }]);
    files = rows[0]?.files || [];
  }
  const totals = new Map();
  for (const file of files) { const filePath = String(file.path || file.filename || ""); if (!safeAnalyticsPath(filePath)) continue; const language = languageFor(filePath); const size = Number(file.size); if (language && Number.isFinite(size) && size >= 0) totals.set(language, (totals.get(language) || 0) + size); }
  const totalBytes = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return { languages: [...totals].map(([name, bytes]) => ({ name, bytes, percentage: totalBytes ? Number((bytes * 100 / totalBytes).toFixed(1)) : 0 })).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)), totalBytes, branch: branchName };
}

async function getBranchAnalytics({ Repository, repository, range }) {
  const rows = await Repository.aggregate([{ $match: { _id: repository._id } }, { $unwind: "$commits" }, { $match: { "commits.time": { $gte: range.from, $lte: range.to } } }, { $group: { _id: { $ifNull: ["$commits.branch", repository.defaultBranch || "main"] }, commits: { $sum: 1 }, lastCommitAt: { $max: "$commits.time" } } }]);
  const counts = new Map(rows.map((row) => [row._id, row]));
  const branches = (repository.branches || []).map((branch) => ({ name: branch.name, isDefault: branch.name === repository.defaultBranch || branch.isDefault, protected: Boolean((repository.branchProtections || []).some((rule) => rule.enabled !== false && rule.branch === branch.name)), commits: counts.get(branch.name)?.commits || 0, lastCommitAt: counts.get(branch.name)?.lastCommitAt || branch.updatedAt || null }));
  return { totalBranches: branches.length, defaultBranch: repository.defaultBranch || "main", protectedBranches: branches.filter((branch) => branch.protected).length, mostActiveBranch: [...branches].sort((a, b) => b.commits - a.commits)[0] || null, branches, range: range.key };
}

function issueStatusExpression() { return { $switch: { branches: [{ case: { $eq: ["$status", "closed"] }, then: "closed" }, { case: { $eq: ["$closed", true] }, then: "closed" }, { case: { $eq: ["$state", "closed"] }, then: "closed" }], default: "open" } }; }
async function getIssueAnalytics({ Issue, repository, range }) {
  const rows = await Issue.aggregate([{ $match: { repository: repository._id } }, { $addFields: { normalizedStatus: issueStatusExpression() } }, { $facet: {
    summary: [{ $group: { _id: "$normalizedStatus", count: { $sum: 1 } } }],
    opened: [{ $match: { createdAt: { $gte: range.from, $lte: range.to } } }, { $group: { _id: dateGroupExpression(range.interval, "$createdAt"), count: { $sum: 1 } } }],
    closed: [{ $match: { closedAt: { $gte: range.from, $lte: range.to } } }, { $group: { _id: dateGroupExpression(range.interval, "$closedAt"), count: { $sum: 1 } } }],
    resolution: [{ $match: { normalizedStatus: "closed", closedAt: { $type: "date" }, createdAt: { $type: "date" } } }, { $group: { _id: null, milliseconds: { $avg: { $subtract: ["$closedAt", "$createdAt"] } } } }],
    oldest: [{ $match: { normalizedStatus: "open" } }, { $sort: { createdAt: 1 } }, { $limit: 1 }, { $project: { _id: 1, number: 1, title: 1, createdAt: 1 } }],
  } }]);
  const result = rows[0] || {}; const summary = Object.fromEntries((result.summary || []).map((row) => [row._id, row.count]));
  return { summary: { open: summary.open || 0, closed: summary.closed || 0, averageResolutionHours: result.resolution?.[0] ? Number((result.resolution[0].milliseconds / 3600000).toFixed(1)) : null }, openedSeries: result.opened || [], closedSeries: result.closed || [], oldestOpenIssue: result.oldest?.[0] || null, interval: range.interval, range: range.key };
}

async function getPullRequestAnalytics({ PullRequest, repository, range }) {
  const rows = await PullRequest.aggregate([{ $match: { repository: repository._id } }, { $facet: {
    summary: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
    opened: [{ $match: { createdAt: { $gte: range.from, $lte: range.to } } }, { $group: { _id: dateGroupExpression(range.interval, "$createdAt"), count: { $sum: 1 } } }],
    merged: [{ $match: { mergedAt: { $gte: range.from, $lte: range.to } } }, { $group: { _id: dateGroupExpression(range.interval, "$mergedAt"), count: { $sum: 1 } } }],
    mergeTime: [{ $match: { status: "merged", mergedAt: { $type: "date" }, createdAt: { $type: "date" } } }, { $group: { _id: null, milliseconds: { $avg: { $subtract: ["$mergedAt", "$createdAt"] } } } }],
    reviewTime: [{ $unwind: "$reviews" }, { $group: { _id: "$_id", firstReview: { $min: "$reviews.createdAt" }, createdAt: { $first: "$createdAt" } } }, { $match: { firstReview: { $type: "date" } } }, { $group: { _id: null, milliseconds: { $avg: { $subtract: ["$firstReview", "$createdAt"] } } } }],
  } }]);
  const result = rows[0] || {}; const summary = Object.fromEntries((result.summary || []).map((row) => [row._id, row.count]));
  return { summary: { open: summary.open || 0, closed: summary.closed || 0, merged: summary.merged || 0, averageMergeHours: result.mergeTime?.[0] ? Number((result.mergeTime[0].milliseconds / 3600000).toFixed(1)) : null, averageReviewHours: result.reviewTime?.[0] ? Number((result.reviewTime[0].milliseconds / 3600000).toFixed(1)) : null }, openedSeries: result.opened || [], mergedSeries: result.merged || [], interval: range.interval, range: range.key };
}

async function getRecentActivity({ Repository, Issue, PullRequest, Tag, Release, repository, range, query }) {
  const pagination = parsePagination(query, 20, 50); const filter = String(query.type || "all");
  if (!["all", "commits", "issues", "pull_requests", "branches", "repository", "tags", "releases"].includes(filter)) throw insightError(400, "Invalid activity type");
  const cap = pagination.skip + pagination.limit + 1;
  const tasks = [];
  if (["all", "commits"].includes(filter)) tasks.push(Repository.aggregate([{ $match: { _id: repository._id } }, { $unwind: "$commits" }, { $match: { "commits.time": { $gte: range.from, $lte: range.to } } }, { $sort: { "commits.time": -1 } }, { $limit: cap }, { $project: { _id: 0, type: { $literal: "commit" }, actorName: { $ifNull: ["$commits.author.name", "Deleted contributor"] }, title: { $concat: ["Committed to ", { $ifNull: ["$commits.branch", repository.defaultBranch || "main"] }] }, message: "$commits.message", createdAt: "$commits.time", target: "$commits.hash" } }]));
  if (["all", "issues"].includes(filter)) tasks.push(Issue.find({ repository: repository._id, $or: [{ createdAt: { $gte: range.from, $lte: range.to } }, { closedAt: { $gte: range.from, $lte: range.to } }] }).select("number title author createdAt status closedAt closedBy").populate("author", "_id username name avatarUrl").populate("closedBy", "_id username name avatarUrl").sort({ createdAt: -1 }).limit(cap).lean().then((items) => items.flatMap((item) => [{ type: "issue_opened", actor: item.author, title: `Opened issue #${item.number || "?"}`, message: item.title, createdAt: item.createdAt, url: `/repo/${repository._id}/issues/${item.number}` }, ...(item.closedAt && item.closedAt >= range.from && item.closedAt <= range.to ? [{ type: "issue_closed", actor: item.closedBy, title: `Closed issue #${item.number || "?"}`, message: item.title, createdAt: item.closedAt, url: `/repo/${repository._id}/issues/${item.number}` }] : [])].filter((event) => event.createdAt >= range.from && event.createdAt <= range.to))));
  if (["all", "pull_requests"].includes(filter)) tasks.push(PullRequest.find({ repository: repository._id, $or: [{ createdAt: { $gte: range.from, $lte: range.to } }, { mergedAt: { $gte: range.from, $lte: range.to } }] }).select("number title author createdAt status mergedAt mergedBy").populate("author", "_id username name avatarUrl").populate("mergedBy", "_id username name avatarUrl").sort({ createdAt: -1 }).limit(cap).lean().then((items) => items.flatMap((item) => [{ type: "pull_request_opened", actor: item.author, title: `Opened pull request #${item.number}`, message: item.title, createdAt: item.createdAt, url: `/repo/${repository._id}/pulls/${item.number}` }, ...(item.mergedAt && item.mergedAt >= range.from && item.mergedAt <= range.to ? [{ type: "pull_request_merged", actor: item.mergedBy, title: `Merged pull request #${item.number}`, message: item.title, createdAt: item.mergedAt, url: `/repo/${repository._id}/pulls/${item.number}` }] : [])].filter((event) => event.createdAt >= range.from && event.createdAt <= range.to))));
  if (Tag && ["all", "tags"].includes(filter)) tasks.push(Tag.find({ repository: repository._id, createdAt: { $gte: range.from, $lte: range.to } }).populate("createdBy", "_id username name avatarUrl").sort({ createdAt: -1 }).limit(cap).lean().then((items) => items.map((item) => ({ type: "tag_created", actor: item.createdBy, title: `Created tag ${item.name}`, message: item.message || item.targetCommitHash, createdAt: item.createdAt, url: `/repo/${repository._id}/releases` }))));
  if (Release && ["all", "releases"].includes(filter)) tasks.push(Release.find({ repository: repository._id, draft: false, publishedAt: { $gte: range.from, $lte: range.to } }).populate("createdBy", "_id username name avatarUrl").populate("tag", "name").sort({ publishedAt: -1 }).limit(cap).lean().then((items) => items.map((item) => ({ type: "release_published", actor: item.createdBy, title: `Published ${item.title}`, message: item.tag?.name || "Release", createdAt: item.publishedAt, url: `/repo/${repository._id}/releases/${item._id}` }))));
  const groups = await Promise.all(tasks); let items = groups.flat().map((item) => item.type === "commit" ? { ...item, actor: { username: item.actorName }, url: `/repo/${repository._id}?branch=${encodeURIComponent(String(item.title).replace("Committed to ", ""))}` } : item);
  if (["all", "branches"].includes(filter)) items.push(...(repository.branches || []).filter((branch) => branch.createdAt && branch.createdAt >= range.from && branch.createdAt <= range.to).map((branch) => ({ type: "branch_created", actor: repository.owner, title: `Created branch ${branch.name}`, message: branch.name, createdAt: branch.createdAt, url: `/repo/${repository._id}?branch=${encodeURIComponent(branch.name)}` })));
  if (["all", "repository"].includes(filter) && repository.createdAt >= range.from && repository.createdAt <= range.to) items.push({ type: "repository_created", actor: repository.owner, title: "Created repository", message: repository.name, createdAt: repository.createdAt, url: `/repo/${repository._id}` });
  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); const hasMore = items.length > pagination.skip + pagination.limit; items = items.slice(pagination.skip, pagination.skip + pagination.limit);
  return { items, pagination: { page: pagination.page, limit: pagination.limit, total: null, pages: null, hasMore }, filter, range: range.key };
}

async function getMostChangedFiles({ Repository, repository, range, query }) {
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 10));
  const rows = await Repository.aggregate([{ $match: { _id: repository._id } }, { $unwind: "$commits" }, { $match: { "commits.time": { $gte: range.from, $lte: range.to } } }, { $unwind: "$commits.files" }, { $group: { _id: "$commits.files.path", changes: { $sum: 1 }, lastChangedAt: { $max: "$commits.time" } } }, { $sort: { changes: -1, _id: 1 } }, { $limit: 100 }]);
  return { files: rows.filter((row) => safeAnalyticsPath(row._id)).slice(0, limit).map((row) => ({ path: row._id, changes: row.changes, additions: null, deletions: null, lastChangedAt: row.lastChangedAt })), additionsAvailable: false, deletionsAvailable: false, range: range.key };
}

module.exports = { RANGE_DAYS, MAX_CUSTOM_DAYS, insightError, parseRange, parsePagination, fillSeries, getOverview, getCommitActivity, getContributors, getLanguages, getBranchAnalytics, getIssueAnalytics, getPullRequestAnalytics, getRecentActivity, getMostChangedFiles, getWorkflowAnalytics, safeAnalyticsPath, idOf, health: require("./repositoryHealthService") };
