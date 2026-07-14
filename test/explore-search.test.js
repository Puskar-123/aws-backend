const test = require("node:test");
const assert = require("node:assert/strict");
const Repository = require("../models/repoModel");
const {
  MAX_LIMIT,
  createPublicDiscoveryController,
  escapeRegex,
  normalizeQuery,
  pagination,
  repositoryPipeline,
  userPipeline,
} = require("../controllers/publicDiscoveryController");
const { detectRepositoryLanguage } = require("../services/repositoryLanguageService");

const sample = { _id: "repo-b", name: "search-test", description: "React application", visibility: "public", language: "JavaScript", starCount: 4, forkCount: 2, watcherCount: 3, commitCount: 5, owner: { _id: "user-b", username: "AccountB", avatarUrl: "" } };
const aggregateResult = (items = [sample], total = items.length) => [{ metadata: total ? [{ total }] : [], repositories: items }];
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("repository discovery indexes public visibility with recent and name access", () => {
  const indexes = Repository.schema.indexes();
  assert.ok(indexes.some(([fields]) => fields.visibility === 1 && fields.updatedAt === -1));
  assert.ok(indexes.some(([fields]) => fields.visibility === 1 && fields.name === 1));
});

test("Explore aggregation starts with public-only filtering and safe owner lookup", () => {
  const pipeline = repositoryPipeline();
  assert.deepEqual(pipeline[0], { $match: { visibility: "public" } });
  assert.equal(pipeline[1].$lookup.from, "users");
  const projection = pipeline.at(-1).$facet.repositories.at(-1).$project;
  assert.equal(projection.content, undefined); assert.equal(projection.commits, undefined); assert.equal(projection.stars, undefined);
  assert.deepEqual(projection.owner._id, "$owner._id");
});

test("repository name, description, and owner searches are case-insensitive and regex escaped", () => {
  assert.equal(escapeRegex("react.*[x]"), "react\\.\\*\\[x\\]");
  const match = repositoryPipeline({ q: "React.*", owner: "AccountB" }).find((stage, index) => index > 2 && stage.$match).$match;
  assert.equal(match.$and[0].$or[0].name.source, "React\\.\\*"); assert.equal(match.$and[0].$or[0].name.flags, "i");
  const text = JSON.stringify(match, (_key, value) => value instanceof RegExp ? `${value.source}/${value.flags}` : value);
  assert.match(text, /name/); assert.match(text, /description/); assert.match(text, /owner\.username/); assert.match(text, /i/);
});

test("Explore supports language, pagination, and every allowed sort without loading arrays", () => {
  for (const [sort, expected] of [["recent", "updatedAt"], ["stars", "starCount"], ["forks", "forkCount"], ["watchers", "watcherCount"], ["name", "normalizedName"]]) {
    const pipeline = repositoryPipeline({ language: "javascript", sort, page: 3, limit: 10 });
    const sortStage = pipeline.find((stage) => stage.$sort).$sort; assert.ok(Object.hasOwn(sortStage, expected));
    const paged = pipeline.at(-1).$facet.repositories; assert.deepEqual(paged[0], { $skip: 20 }); assert.deepEqual(paged[1], { $limit: 10 });
    assert.ok(pipeline.some((stage) => stage.$match?.language instanceof RegExp));
  }
});

test("legacy repositories without language remain in Explore and project an empty language", () => {
  const pipeline = repositoryPipeline();
  assert.equal(pipeline.filter((stage) => stage.$match).some((stage) => stage.$match.language), false);
  assert.deepEqual(pipeline.at(-1).$facet.repositories.at(-1).$project.language, { $ifNull: ["$language", ""] });
});

test("query normalization trims whitespace, rejects empty required and very long input", () => {
  assert.equal(normalizeQuery("  account   b  "), "account b");
  assert.throws(() => normalizeQuery(" ", { required: true }), /required/);
  assert.throws(() => normalizeQuery("x".repeat(101), { required: true }), /100/);
  assert.equal(pagination({ limit: 500 }).limit, MAX_LIMIT);
});

test("Explore returns repositories from other owners with complete pagination", async () => {
  let pipeline;
  const controller = createPublicDiscoveryController({ RepoModel: { aggregate: async (value) => { pipeline = value; return aggregateResult([sample], 42); } }, UserModel: {} });
  const res = response(); await controller.explore({ query: { q: "SEARCH", page: "2", limit: "20", sort: "stars" } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.repositories[0].owner.username, "AccountB"); assert.equal(res.body.pagination.total, 42); assert.equal(res.body.pagination.hasNextPage, true);
  assert.deepEqual(pipeline[0], { $match: { visibility: "public" } });
});

test("invalid Explore sort is rejected before a database query", async () => {
  let called = false; const controller = createPublicDiscoveryController({ RepoModel: { aggregate: async () => { called = true; } }, UserModel: {} }); const res = response();
  await controller.explore({ query: { sort: "secret" } }, res); assert.equal(res.statusCode, 400); assert.equal(called, false);
});

test("global search requires a bounded query and never queries on empty input", async () => {
  let calls = 0; const controller = createPublicDiscoveryController({ RepoModel: { aggregate: async () => { calls += 1; } }, UserModel: { aggregate: async () => { calls += 1; } } });
  let res = response(); await controller.search({ query: { q: "" } }, res); assert.equal(res.statusCode, 400); assert.equal(calls, 0);
  res = response(); await controller.search({ query: { q: "x".repeat(101) } }, res); assert.equal(res.statusCode, 400); assert.equal(calls, 0);
});

test("global repository search cannot discover private IDs", async () => {
  const controller = createPublicDiscoveryController({ RepoModel: { aggregate: async (pipeline) => { assert.deepEqual(pipeline[0], { $match: { visibility: "public" } }); return aggregateResult([], 0); } }, UserModel: { aggregate: async () => [] } });
  const res = response(); await controller.search({ query: { q: "private-repo", type: "repositories" } }, res); assert.deepEqual(res.body.repositories, []);
});

test("user search projection exposes safe fields only and counts public repositories", () => {
  const pipeline = userPipeline({ q: "puskar", page: 1, limit: 20 }); const project = pipeline.at(-1).$facet.users.at(-1).$project;
  assert.equal(project.username, 1); assert.equal(project.publicRepositoryCount.$ifNull.length, 2);
  for (const secret of ["email", "password", "token", "repositories"]) assert.equal(project[secret], undefined);
  const lookup = pipeline.at(-1).$facet.users.find((stage) => stage.$lookup).$lookup; assert.equal(lookup.pipeline[0].$match.$expr.$and[1].$eq[1], "public");
});

test("public username profile returns safe fields, public repositories, and total stars", async () => {
  const user = { _id: "507f1f77bcf86cd799439011", username: "AccountB", name: "Account B", email: "hidden@example.com", password: "hidden", followers: [], following: [] };
  let aggregateCall = 0;
  const controller = createPublicDiscoveryController({
    UserModel: { findOne: () => ({ select: () => ({ lean: async () => user }) }) },
    RepoModel: { aggregate: async (pipeline) => { aggregateCall += 1; assert.equal(pipeline[0].$match.visibility || pipeline[0].$match.owner, pipeline[0].$match.visibility ? "public" : user._id); return aggregateCall === 1 ? aggregateResult([sample], 1) : [{ total: 4 }]; } },
  });
  const res = response(); await controller.publicProfile({ params: { username: "accountb" } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.user.username, "AccountB"); assert.equal(res.body.user.email, undefined); assert.equal(res.body.user.password, undefined); assert.equal(res.body.publicRepositoryCount, 1); assert.equal(res.body.totalStarsReceived, 4);
});

test("missing public username returns 404 without revealing repositories", async () => {
  let repoCalls = 0; const controller = createPublicDiscoveryController({ UserModel: { findOne: () => ({ select: () => ({ lean: async () => null }) }) }, RepoModel: { aggregate: async () => { repoCalls += 1; } } });
  const res = response(); await controller.publicProfile({ params: { username: "missing" } }, res); assert.equal(res.statusCode, 404); assert.equal(repoCalls, 0);
});

test("language detection ignores protected files and chooses the most frequent source language", () => {
  assert.equal(detectRepositoryLanguage([{ path: "src/a.js" }, { path: "src/b.jsx" }, { path: "tool.py" }, { path: ".env" }]), "JavaScript");
  assert.equal(detectRepositoryLanguage([{ path: "README.md" }]), "");
});

test("Explore and global discovery routes are public and precede repository ID handling", () => {
  const repoRoutes = require("../routes/repo.router").stack.filter((layer) => layer.route);
  const explore = repoRoutes.find((layer) => layer.route.path === "/explore"); assert.equal(explore.route.stack.length, 1);
  assert.ok(repoRoutes.indexOf(explore) < repoRoutes.findIndex((layer) => layer.route.path === "/:id"));
  const mainRoutes = require("../routes/main.router").stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.ok(mainRoutes.includes("/search")); assert.ok(mainRoutes.includes("/users/:username")); assert.ok(mainRoutes.includes("/users/:username/repositories"));
});
