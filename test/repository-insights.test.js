const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const service = require("../services/repositoryInsightsService");
const { createRepositoryInsightsController } = require("../controllers/repositoryInsightsController");

const repositoryId = new mongoose.Types.ObjectId(); const owner = new mongoose.Types.ObjectId(); const collaborator = new mongoose.Types.ObjectId(); const outsider = new mongoose.Types.ObjectId();
const repository = (overrides = {}) => ({ _id: repositoryId, name: "analytics", owner: { _id: owner, username: "owner" }, visibility: "public", defaultBranch: "main", branches: [{ name: "main", isDefault: true }, { name: "feature" }], branchProtections: [{ branch: "main", enabled: true }], stars: [owner], watchers: [owner, collaborator], forks: [], collaborators: [{ user: collaborator, role: "read" }], ...overrides });
const range = service.parseRange({ range: "30d" }, new Date("2026-07-14T12:00:00Z"));
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("range parsing validates presets, UTC custom dates, maximum bounds, and pagination limits", () => {
  assert.equal(range.interval, "day"); assert.equal(range.timezone, "UTC");
  assert.equal(service.parseRange({ range: "90d" }, new Date("2026-07-14Z")).interval, "week");
  assert.equal(service.parseRange({ range: "all" }).interval, "month");
  assert.equal(service.parseRange({ from: "2026-07-01", to: "2026-07-07" }).key, "custom");
  for (const query of [{ range: "bad" }, { from: "2026-01-01" }, { from: "bad", to: "2026-01-02" }, { from: "2026-02-01", to: "2026-01-01" }]) assert.throws(() => service.parseRange(query), { status: 400 });
  assert.equal(service.parsePagination({ limit: "500" }).limit, 100);
  assert.throws(() => service.parsePagination({ page: "101" }), { status: 400 });
});

test("commit activity fills missing dates, filters branches in aggregation, and avoids duplicate row counting", async () => {
  let pipeline;
  const Repository = { aggregate: async (value) => { pipeline = value; return [{ _id: "2026-07-13", count: 2 }, { _id: "2026-07-14", count: 1 }]; } };
  const result = await service.getCommitActivity({ Repository, repository: repository(), range: service.parseRange({ range: "7d" }, new Date("2026-07-14T12:00:00Z")), branch: "main" });
  assert.equal(result.series.length, 7); assert.equal(result.series.at(-1).commits, 1); assert.equal(result.totalCommits, 3);
  assert.equal(pipeline.some((stage) => stage.$unwind === "$commits"), true);
  assert.equal(pipeline.find((stage) => stage.$match?.["commits.branch"])?.$match["commits.branch"], "main");
});

test("overview combines accurate document counts, social totals, branches, and distinct contributors", async () => {
  const Repository = { aggregate: async () => [{ commits: 4, contributors: ["Owner", "Contributor"] }] };
  const Issue = { aggregate: async () => [{ _id: "open", count: 2 }, { _id: "closed", count: 3 }] };
  const PullRequest = { aggregate: async () => [{ _id: "open", count: 1 }, { _id: "merged", count: 5 }] };
  const result = await service.getOverview({ Repository, Issue, PullRequest, repository: repository(), range });
  assert.deepEqual(result.summary, { commits: 4, contributors: 2, branches: 2, openIssues: 2, closedIssues: 3, openPullRequests: 1, closedPullRequests: 0, mergedPullRequests: 5, stars: 1, forks: 0, watchers: 2 });
  assert.equal(result.socialHistoryAvailable, false);
});

test("contributors are ranked without exposing email and unavailable summaries remain null", async () => {
  const Repository = { aggregate: async () => [{ items: [{ _id: "Legacy Author", commits: 3, additions: 12, deletions: 4, filesChanged: 5, missingSummary: 1, lastContributionAt: new Date("2026-07-14") }], total: [{ count: 1 }] }] };
  const result = await service.getContributors({ Repository, repository: repository(), range, query: {} });
  assert.equal(result.contributors[0].name, "Legacy Author"); assert.equal(result.contributors[0].commits, 3); assert.equal(result.contributors[0].additions, null); assert.equal(result.contributors[0].email, undefined);
});

test("language statistics use stored bytes and exclude protected, generated, binary, and unknown files", async () => {
  const content = [
    { path: "src/app.js", size: 600 }, { path: "styles/app.css", size: 300 }, { path: "index.html", size: 100 },
    { path: ".env", size: 5000 }, { path: "dist/bundle.js", size: 9000 }, { path: "logo.png", size: 1000 }, { path: "missing.js" },
  ];
  const Repository = { findById: () => ({ select() { return this; }, lean: async () => ({ content }) }) };
  const result = await service.getLanguages({ Repository, repository: repository(), branch: "main" });
  assert.equal(result.totalBytes, 1000); assert.deepEqual(result.languages.map((item) => [item.name, item.bytes, item.percentage]), [["JavaScript", 600, 60], ["CSS", 300, 30], ["HTML", 100, 10]]);
  const legacy = await service.getLanguages({ Repository: { findById: () => ({ select() { return this; }, lean: async () => ({ content: [{ path: "app.js" }] }) }) }, repository: repository(), branch: "main" });
  assert.equal(legacy.totalBytes, 0); assert.deepEqual(legacy.languages, []);
});

test("branch, issue, and pull-request analytics preserve accurate stored timestamps", async () => {
  const branchResult = await service.getBranchAnalytics({ Repository: { aggregate: async () => [{ _id: "main", commits: 5, lastCommitAt: new Date("2026-07-14") }, { _id: "feature", commits: 2, lastCommitAt: new Date("2026-07-13") }] }, repository: repository(), range });
  assert.equal(branchResult.totalBranches, 2); assert.equal(branchResult.protectedBranches, 1); assert.equal(branchResult.mostActiveBranch.name, "main");
  const Issue = { aggregate: async () => [{ summary: [{ _id: "open", count: 2 }, { _id: "closed", count: 1 }], opened: [], closed: [], resolution: [{ milliseconds: 7200000 }], oldest: [{ number: 1, title: "Old" }] }] };
  const issues = await service.getIssueAnalytics({ Issue, repository: repository(), range }); assert.equal(issues.summary.averageResolutionHours, 2); assert.equal(issues.summary.open, 2);
  const PullRequest = { aggregate: async () => [{ summary: [{ _id: "open", count: 1 }, { _id: "merged", count: 2 }], opened: [], merged: [], mergeTime: [{ milliseconds: 10800000 }], reviewTime: [{ milliseconds: 3600000 }] }] };
  const pulls = await service.getPullRequestAnalytics({ PullRequest, repository: repository(), range }); assert.equal(pulls.summary.merged, 2); assert.equal(pulls.summary.averageMergeHours, 3); assert.equal(pulls.summary.averageReviewHours, 1);
});

test("most changed files excludes protected and generated paths without inventing line totals", async () => {
  const Repository = { aggregate: async () => [{ _id: ".env", changes: 50 }, { _id: "dist/app.js", changes: 40 }, { _id: "src/app.js", changes: 4, lastChangedAt: new Date("2026-07-14") }] };
  const result = await service.getMostChangedFiles({ Repository, repository: repository(), range, query: {} });
  assert.deepEqual(result.files.map((file) => file.path), ["src/app.js"]); assert.equal(result.files[0].additions, null); assert.equal(result.additionsAvailable, false);
});

function listQuery(items) { return { select() { return this; }, populate() { return this; }, sort() { return this; }, limit() { return this; }, lean() { return Promise.resolve(items); } }; }
test("activity supports filtering, safe links, chronological pagination, and branch events", async () => {
  const activeRepository = repository({ createdAt: new Date("2026-07-10T00:00:00Z"), branches: [{ name: "main", createdAt: new Date("2026-07-11T00:00:00Z") }] });
  const Repository = { aggregate: async () => [{ type: "commit", actorName: "Owner", title: "Committed to main", message: "Fix auth", createdAt: new Date("2026-07-14T00:00:00Z"), target: "c1" }] };
  const Issue = { find: () => listQuery([{ number: 2, title: "Bug", author: { username: "user" }, createdAt: new Date("2026-07-12T00:00:00Z") }]) };
  const PullRequest = { find: () => listQuery([{ number: 3, title: "Feature", author: { username: "reviewer" }, createdAt: new Date("2026-07-13T00:00:00Z") }]) };
  const result = await service.getRecentActivity({ Repository, Issue, PullRequest, repository: activeRepository, range, query: { type: "all", limit: "3" } });
  assert.equal(result.items.length, 3); assert.equal(result.items[0].type, "commit"); assert.equal(result.pagination.hasMore, true); assert.match(result.items[0].url, /^\/repo\//);
  const branches = await service.getRecentActivity({ Repository, Issue, PullRequest, repository: activeRepository, range, query: { type: "branches" } }); assert.equal(branches.items[0].type, "branch_created");
  await assert.rejects(() => service.getRecentActivity({ Repository, Issue, PullRequest, repository: activeRepository, range, query: { type: "secret" } }), { status: 400 });
});

function repositoryQuery(value) { return { select() { return this; }, populate() { return this; }, lean: async () => value }; }
function controllerModels(repo) {
  return {
    RepositoryModel: { findById: (id) => repositoryQuery(String(id) === String(repo._id) ? repo : null), aggregate: async () => [{ commits: 0, contributors: [] }] },
    IssueModel: { aggregate: async () => [] }, PullRequestModel: { aggregate: async () => [] },
  };
}
test("insights access permits public and private collaborators while denying unrelated direct access", async () => {
  let controller = createRepositoryInsightsController(controllerModels(repository())); let res = response(); await controller.overview({ params: { id: String(repositoryId) }, query: {}, user: null }, res); assert.equal(res.statusCode, 200);
  const privateRepo = repository({ visibility: "private" }); controller = createRepositoryInsightsController(controllerModels(privateRepo));
  res = response(); await controller.overview({ params: { id: String(repositoryId) }, query: {}, user: { id: String(collaborator) } }, res); assert.equal(res.statusCode, 200);
  res = response(); await controller.overview({ params: { id: String(repositoryId) }, query: {}, user: { id: String(outsider) } }, res); assert.equal(res.statusCode, 403);
  res = response(); await controller.overview({ params: { id: String(repositoryId) }, query: {}, user: null }, res); assert.equal(res.statusCode, 401);
  res = response(); await controller.overview({ params: { id: String(new mongoose.Types.ObjectId()) }, query: {}, user: null }, res); assert.equal(res.statusCode, 404);
});

test("insights routes are public-read aware and registered before generic repository details", () => {
  const router = require("../routes/repo.router"); const paths = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path); const generic = paths.indexOf("/:id");
  for (const suffix of ["overview", "commits", "contributors", "languages", "issues", "pull-requests", "branches", "activity", "files"]) { const route = `/:id/insights/${suffix}`; assert.ok(paths.includes(route)); assert.ok(paths.indexOf(route) < generic); }
});
