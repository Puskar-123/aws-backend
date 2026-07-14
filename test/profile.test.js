const assert = require("node:assert/strict");
const test = require("node:test");
const { ObjectId } = require("mongodb");
const { createProfileController } = require("../controllers/profileController");
const { validateProfileUpdate } = require("../utils/profile");
const User = require("../models/userModel");

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function fixtures() {
  const userId = new ObjectId();
  const otherId = new ObjectId();
  const user = {
    _id: userId,
    username: "developer",
    email: "developer@example.com",
    password: "hashed-password",
    followers: [otherId],
    following: [],
    createdAt: new Date("2026-01-02T12:00:00Z"),
  };
  const repositories = [
    {
      _id: new ObjectId(),
      name: "public-repo",
      visibility: "true",
      createdAt: new Date("2026-01-03T12:00:00Z"),
      updatedAt: new Date("2026-01-04T12:00:00Z"),
      commits: [{ message: "Public change", time: new Date("2026-01-04T12:00:00Z") }],
    },
    {
      _id: new ObjectId(),
      name: "private-repo",
      visibility: "false",
      createdAt: new Date("2026-01-05T12:00:00Z"),
      commits: [{ message: "Secret change", time: new Date("2026-01-06T12:00:00Z") }],
    },
  ];
  return { userId, otherId, user, repositories };
}

test("user schema supports optional profile fields without breaking legacy documents", () => {
  const user = new User({ username: "legacy-schema-user", email: "legacy@example.com" });
  assert.equal(user.validateSync(), undefined);
  assert.equal(user.name, "");
  assert.equal(user.bio, "");
  assert.deepEqual(user.followers, []);
  assert.deepEqual(user.starredRepositories, []);

  user.bio = "x".repeat(161);
  assert.match(user.validateSync().errors.bio.message, /maximum allowed length/);
});

test("profile read returns real owner summary without exposing password", async () => {
  const data = fixtures();
  const controller = createProfileController({
    connect: async () => {},
    users: () => ({ findOne: async () => data.user }),
    findRepositories: async () => data.repositories,
    findStarredRepositories: async () => [],
  });
  const res = response();
  await controller.getProfile({ params: { id: String(data.userId) }, user: { id: String(data.userId) } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.username, "developer");
  assert.equal(res.body.user.email, "developer@example.com");
  assert.equal("password" in res.body.user, false);
  assert.deepEqual(res.body.stats, {
    repositories: 2,
    publicRepositories: 1,
    privateRepositories: 1,
    commits: 2,
    contributions: 4,
  });
  assert.equal(res.body.contributions.length, 4);
  assert.equal(res.body.recentActivity.length, 4);
});

test("public profile read hides email and private repository data", async () => {
  const data = fixtures();
  const controller = createProfileController({
    connect: async () => {},
    users: () => ({ findOne: async () => data.user }),
    findRepositories: async () => data.repositories,
    findStarredRepositories: async () => [],
  });
  const res = response();
  await controller.getProfile({ params: { id: String(data.userId) }, user: null }, res);

  assert.equal("email" in res.body.user, false);
  assert.equal("privateRepositories" in res.body.stats, false);
  assert.equal(res.body.stats.repositories, 1);
  assert.equal(res.body.stats.commits, 1);
  assert.equal(res.body.recentActivity.some((item) => item.repositoryName === "private-repo"), false);
});

test("profile read validates IDs, returns 404, and supports legacy users", async () => {
  let user = null;
  const controller = createProfileController({
    connect: async () => {},
    users: () => ({ findOne: async () => user }),
    findRepositories: async () => [],
    findStarredRepositories: async () => [],
  });
  const invalid = response();
  await controller.getProfile({ params: { id: "invalid" }, user: null }, invalid);
  assert.equal(invalid.statusCode, 400);

  const missing = response();
  await controller.getProfile({ params: { id: String(new ObjectId()) }, user: null }, missing);
  assert.equal(missing.statusCode, 404);

  user = { _id: new ObjectId(), username: "legacy", followedUsers: [] };
  const legacy = response();
  await controller.getProfile({ params: { id: String(user._id) }, user: null }, legacy);
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.body.user.name, "");
  assert.equal(legacy.body.user.followersCount, 0);
});

test("owner profile update allowlists fields and never writes password or email", async () => {
  const data = fixtures();
  let writtenUpdate;
  const updatedUser = { ...data.user, name: "Code Hub", bio: "Builder" };
  const controller = createProfileController({
    connect: async () => {},
    users: () => ({
      findOneAndUpdate: async (_filter, update) => {
        writtenUpdate = update.$set;
        return updatedUser;
      },
    }),
  });
  const res = response();
  await controller.updateProfile({
    params: { id: String(data.userId) },
    user: { id: String(data.userId) },
    body: { name: " Code Hub ", bio: "Builder", password: "new-password", email: "other@example.com" },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(writtenUpdate, { name: "Code Hub", bio: "Builder" });
  assert.equal("password" in res.body.user, false);
});

test("profile update rejects another user and unsafe website schemes", async () => {
  const data = fixtures();
  let updateCalls = 0;
  const controller = createProfileController({
    connect: async () => {},
    users: () => ({ findOneAndUpdate: async () => { updateCalls += 1; } }),
  });
  const forbidden = response();
  await controller.updateProfile({
    params: { id: String(data.userId) },
    user: { id: String(data.otherId) },
    body: { name: "No" },
  }, forbidden);
  assert.equal(forbidden.statusCode, 403);

  const unsafe = response();
  await controller.updateProfile({
    params: { id: String(data.userId) },
    user: { id: String(data.userId) },
    body: { website: "javascript:alert(1)" },
  }, unsafe);
  assert.equal(unsafe.statusCode, 400);
  assert.equal(updateCalls, 0);
  assert.throws(() => validateProfileUpdate({ avatarUrl: "data:image/png;base64,test" }), /http or https/);
});

test("profile routes keep reads public and require authentication for updates", () => {
  const router = require("../routes/user.router");
  const read = router.stack.find((layer) => layer.route?.path === "/profile/:id" && layer.route.methods.get);
  const update = router.stack.find((layer) => layer.route?.path === "/profile/:id" && layer.route.methods.put);
  assert.equal(read.route.stack.length, 3);
  assert.equal(update.route.stack.length, 3);
  assert.equal(read.route.stack[0].handle.name, "noStore");
  assert.equal(update.route.stack[0].handle.name, "noStore");
  assert.equal(update.route.stack[1].handle.name, "requireAuth");
});
