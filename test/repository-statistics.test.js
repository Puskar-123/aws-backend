const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { buildOwnedRepositoryStatisticsPipeline, getUserRepositoryStats, countOwnedRepositoryCommits } = require("../services/repositoryStatisticsService");
const Repository = require("../models/repoModel");
const repoRouter = require("../routes/repo.router");
const { fetchRepositoriesForCurrentUser } = require("../controllers/repoController");

const owner = new mongoose.Types.ObjectId();

test("user with no repositories receives complete zero statistics", async () => {
  const result = await getUserRepositoryStats(owner, { RepositoryModel: { aggregate: async () => [] } });
  assert.deepEqual(result, { repositories: 0, publicRepositories: 0, privateRepositories: 0, commits: 0 });
});

test("owned public, private, and unique commit totals are returned unchanged", async () => {
  const expected = { repositories: 3, publicRepositories: 2, privateRepositories: 1, commits: 7 };
  assert.deepEqual(await getUserRepositoryStats(owner, { RepositoryModel: { aggregate: async () => [expected] } }), expected);
  assert.equal(await countOwnedRepositoryCommits(owner, { RepositoryModel: { aggregate: async () => [expected] } }), 7);
});

test("aggregation scopes statistics to the authenticated owner and never loads documents", async () => {
  let pipeline; let findCalled = false;
  const RepositoryModel = { aggregate: async (value) => { pipeline = value; return []; }, find: () => { findCalled = true; } };
  await getUserRepositoryStats(owner, { RepositoryModel });
  assert.equal(String(pipeline[0].$match.owner), String(owner)); assert.equal(findCalled, false);
  assert.equal(pipeline.some((stage) => stage.$group?.repositories), true);
});

test("all canonical commit sources share one deduplicated identity pipeline", () => {
  const pipeline = buildOwnedRepositoryStatisticsPipeline(owner);
  const mappedCommit = pipeline[1].$project.commitKeys.$map.in.$let;
  const identity = mappedCommit.in.$concat[2].$ifNull[0].$convert.input;
  assert.deepEqual(identity, { $ifNull: ["$$commit.hash", { $ifNull: ["$$commit._id", "$$commit"] }] });
  assert.deepEqual(mappedCommit.in.$concat.slice(0, 2), [{ $toString: "$_id" }, ":"]);
  assert.deepEqual(pipeline[2].$project.commitKeys.$setDifference[0], { $setUnion: ["$commitKeys", []] });
  assert.deepEqual(pipeline[4].$project.commits.$size.$reduce.in, { $setUnion: ["$$value", "$$this"] });
});

test("commit identities are repository-scoped so equal hashes in different repositories both count", () => {
  const key = buildOwnedRepositoryStatisticsPipeline(owner)[1].$project.commitKeys.$map.in.$let.in.$concat;
  assert.deepEqual(key[0], { $toString: "$_id" });
  assert.equal(key[1], ":");
});

test("branch references cannot duplicate commits", () => {
  const serialized = JSON.stringify(buildOwnedRepositoryStatisticsPipeline(owner));
  assert.equal(serialized.includes("branches"), false); assert.equal(serialized.includes("$unwind"), false);
});

test("legacy IDs are used when hashes are absent and malformed metadata converts safely", () => {
  const fallback = buildOwnedRepositoryStatisticsPipeline(owner)[1].$project.commitKeys.$map.in.$let.in.$concat[2].$ifNull;
  const convert = fallback[0].$convert;
  assert.equal(convert.onError, null); assert.equal(convert.onNull, null);
  assert.deepEqual(convert.input.$ifNull[1], { $ifNull: ["$$commit._id", "$$commit"] });
  assert.deepEqual(fallback[1], { $concat: ["legacy-index-", { $toString: "$$commitIndex" }] });
});

test("missing or non-array legacy commit storage is treated as an empty array", () => {
  const sizeInput = buildOwnedRepositoryStatisticsPipeline(owner)[1].$project.commitKeys.$map.input.$range[1].$size;
  assert.deepEqual(sizeInput, { $cond: [{ $isArray: "$commits" }, "$commits", []] });
});

test("missing legacy visibility remains public unless explicitly private", () => {
  const group = buildOwnedRepositoryStatisticsPipeline(owner)[3].$group;
  assert.deepEqual(group.publicRepositories.$sum, { $cond: [{ $eq: ["$visibility", "private"] }, 0, 1] });
  assert.deepEqual(group.privateRepositories.$sum, { $cond: [{ $eq: ["$visibility", "private"] }, 1, 0] });
});

test("deleted, shared, and other users' repositories are excluded by owner match", () => {
  assert.deepEqual(Object.keys(buildOwnedRepositoryStatisticsPipeline(owner)[0].$match), ["owner"]);
});

test("invalid user IDs are rejected before querying", async () => {
  let queried = false;
  await assert.rejects(() => getUserRepositoryStats("invalid", { RepositoryModel: { aggregate: async () => { queried = true; } } }), { status: 400 });
  assert.equal(queried, false);
});

test("dashboard repository statistics route requires authentication", () => {
  const route = repoRouter.stack.find((layer) => layer.route?.path === "/user/:userID");
  assert.ok(route);
  assert.deepEqual(route.route.stack.map((layer) => layer.name), ["requireAuth", "fetchRepositoriesForCurrentUser"]);
});

test("dashboard response returns backend statistics without commit arrays or collaborator lists", async () => {
  const originalFind = Repository.find;
  const originalAggregate = Repository.aggregate;
  const owned = [{ _id: new mongoose.Types.ObjectId(), name: "Owned", visibility: "private", owner: { _id: owner, username: "owner" }, collaborators: [{ user: new mongoose.Types.ObjectId(), role: "write" }] }];
  const statistics = { repositories: 1, publicRepositories: 0, privateRepositories: 1, commits: 4 };
  Repository.find = (filter) => ({
    select: () => ({
      populate: () => ({
        lean: async () => (filter.owner ? owned : []),
      }),
    }),
  });
  Repository.aggregate = async () => [statistics];
  let response;
  try {
    await fetchRepositoriesForCurrentUser(
      { params: { userID: String(owner) }, user: { id: String(owner) } },
      { json: (body) => { response = body; }, status: () => ({ json: (body) => { response = body; } }) },
    );
  } finally {
    Repository.find = originalFind;
    Repository.aggregate = originalAggregate;
  }
  assert.deepEqual(response.statistics, statistics);
  assert.equal(response.myRepositories.length, 1);
  assert.equal(response.myRepositories[0].collaborators, undefined);
  assert.equal(response.myRepositories[0].commits, undefined);
  assert.deepEqual(response.sharedRepositories, []);
});
