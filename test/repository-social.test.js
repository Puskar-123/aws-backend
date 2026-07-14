const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const { createRepositorySocialController, social } = require("../controllers/repositorySocialController");
const owner = new mongoose.Types.ObjectId(); const sourceId = new mongoose.Types.ObjectId();
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("repository social schema has legacy-safe defaults and unique fork protection", () => {
  const repo = new Repository({ name: "legacy-social", owner });
  assert.deepEqual(repo.stars, []); assert.deepEqual(repo.watchers, []); assert.deepEqual(repo.forks, []); assert.equal(repo.forkedFrom, null);
  assert.ok(Repository.schema.indexes().some(([fields, options]) => fields.owner === 1 && fields.forkedFrom === 1 && options.unique));
});

test("star/watch toggles use atomic duplicate-safe operators", async () => {
  const calls = []; const model = { findByIdAndUpdate: async (_id, update) => { calls.push(update); return { stars: update.$pull ? [] : [owner], watchers: update.$pull ? [] : [owner] }; } };
  const controller = createRepositorySocialController({ RepoModel: model }); const req = { repository: { _id: sourceId }, user: { id: String(owner) } };
  for (const action of ["star", "unstar", "watch", "unwatch"]) { const res = response(); await controller[action](req, res); assert.equal(res.statusCode, 200); }
  assert.ok(calls[0].$addToSet.stars); assert.ok(calls[1].$pull.stars); assert.ok(calls[2].$addToSet.watchers); assert.ok(calls[3].$pull.watchers);
});

test("social counts and current-user status tolerate missing legacy arrays", async () => {
  assert.deepEqual(await social({ _id: sourceId }, String(owner), { exists: async () => null }), { starCount: 0, watcherCount: 0, forkCount: 0, starredByCurrentUser: false, watchedByCurrentUser: false, forkedByCurrentUser: false });
});

test("fork rejects duplicates and preserves safe branches, snapshots, and history", async () => {
  let duplicate = null; let created; let sourceUpdate;
  const model = { findOne: async () => duplicate, exists: async ({ name }) => name === "project", create: async (value) => { created = { _id: new mongoose.Types.ObjectId(), ...value, toObject() { return { ...this, toObject: undefined }; }, async populate() {} }; return created; }, findByIdAndUpdate: async (_id, update) => { sourceUpdate = update; } };
  const controller = createRepositorySocialController({ RepoModel: model });
  const source = { _id: sourceId, name: "project", owner, visibility: "public", description: "Fork me", branches: [{ name: "main", head: "c1", isDefault: true }], content: [{ filename: "README.md", path: "README.md", s3Key: "shared/readme" }, { filename: ".env", path: ".env", s3Key: "secret" }], commits: [{ hash: "c1", snapshot: [{ filename: "README.md", path: "README.md", s3Key: "shared/readme" }], files: [] }] };
  let res = response(); await controller.fork({ repository: source, user: { id: String(owner) } }, res);
  assert.equal(res.statusCode, 201); assert.equal(created.name, "project-fork"); assert.equal(created.branches[0].head, "c1"); assert.equal(created.commits[0].hash, "c1"); assert.equal(created.content.length, 1); assert.equal(created.content[0].s3Key, "shared/readme"); assert.ok(sourceUpdate.$addToSet.forks);
  assert.equal(res.body.repository.commits, undefined); assert.equal(res.body.repository.content, undefined);
  duplicate = { _id: new mongoose.Types.ObjectId() }; res = response(); await controller.fork({ repository: source, user: { id: String(owner) } }, res); assert.equal(res.statusCode, 409);
});

test("social routes are registered before repository details with read authorization", () => {
  const router = require("../routes/repo.router"); const paths = router.stack.map((layer) => layer.route?.path).filter(Boolean); const generic = paths.indexOf("/:id");
  for (const path of ["/:id/star", "/:id/watch", "/:id/fork", "/:id/star-status", "/:id/watch-status"]) assert.ok(paths.indexOf(path) >= 0 && paths.indexOf(path) < generic);
});
