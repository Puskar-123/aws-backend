const test = require("node:test");
const assert = require("node:assert/strict");
const Notification = require("../models/notificationModel");
const { createNotification, notifyRepositoryWatchers, safeNotifyRepositoryWatchers } = require("../services/notificationService");
const { createNotificationController } = require("../controllers/notificationController");

const watcher = "507f1f77bcf86cd799439011";
const actor = "507f1f77bcf86cd799439012";
const repository = { _id: "507f1f77bcf86cd799439013", name: "demo", owner: watcher, visibility: "public", watchers: [watcher, actor, watcher] };

test("notification schema has recipient indexes and duplicate event protection", () => {
  assert.equal(Notification.schema.path("recipient").isRequired, true);
  assert.ok(Notification.schema.indexes().some(([fields]) => fields.recipient === 1 && fields.read === 1));
  assert.ok(Notification.schema.indexes().some(([fields, options]) => fields.eventKey === 1 && options.unique && options.sparse));
});

test("watchers receive one notification while actor, duplicates, and deleted users are excluded", async () => {
  let inserted;
  const result = await notifyRepositoryWatchers(repository, { actor, type: "commit", title: "Commit", url: "/repo/x", eventKey: "commit:x" }, {
    UserModel: { find: () => ({ distinct: async () => [watcher] }) },
    NotificationModel: { insertMany: async (docs) => { inserted = docs; return docs; } },
  });
  assert.equal(result.length, 1); assert.equal(inserted[0].recipient, watcher); assert.equal(inserted[0].eventKey, `commit:x:${watcher}`);
});

test("unwatched users and legacy repositories without watchers receive nothing", async () => {
  let calls = 0; const dependencies = { UserModel: { find: () => ({ distinct: async () => [] }) }, NotificationModel: { insertMany: async () => { calls += 1; } } };
  assert.deepEqual(await notifyRepositoryWatchers({ ...repository, watchers: [] }, { actor, type: "commit", title: "x" }, dependencies), []);
  assert.equal(calls, 0);
});

test("private repository notifications are limited to the owner", async () => {
  let inserted;
  await notifyRepositoryWatchers({ ...repository, visibility: "private", watchers: [watcher, "507f1f77bcf86cd799439099"] }, { actor, type: "issue_opened", title: "Issue" }, {
    UserModel: { find: () => ({ distinct: async () => [watcher, "507f1f77bcf86cd799439099"] }) },
    NotificationModel: { insertMany: async (docs) => { inserted = docs; return docs; } },
  });
  assert.deepEqual(inserted.map((item) => item.recipient), [watcher]);
});

test("self notifications and duplicate event errors are safely ignored", async () => {
  assert.equal(await createNotification({ recipient: actor, actor, type: "commit", title: "x", url: "/" }, { NotificationModel: { create: async () => assert.fail() } }), null);
  const duplicate = await createNotification({ recipient: watcher, actor, type: "commit", title: "x", url: "/" }, { NotificationModel: { create: async () => { throw Object.assign(new Error("duplicate"), { code: 11000 }); } } });
  assert.equal(duplicate, null);
});

test("notification failure never fails the main repository action", async () => {
  const result = await safeNotifyRepositoryWatchers(repository, { actor, type: "commit", title: "x" }, {
    UserModel: { find: () => ({ distinct: async () => [watcher] }) }, NotificationModel: { insertMany: async () => { throw new Error("offline"); } },
  });
  assert.deepEqual(result, []);
});

test("notification routes require authentication and keep fixed paths before IDs", () => {
  const router = require("../routes/notification.router");
  const routes = router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  assert.deepEqual(routes.slice(0, 4), ["/", "/unread-count", "/read-all", "/read"]);
  assert.ok(router.stack[0].name === "requireAuth");
});

test("unread count, mark one, mark all, and deletes are scoped to the authenticated recipient", async () => {
  const calls = [];
  const model = {
    countDocuments: async (filter) => { calls.push(["count", filter]); return 3; },
    findOneAndUpdate: async (filter, update) => { calls.push(["read", filter, update]); return filter.recipient === watcher ? { _id: filter._id, recipient: watcher, title: "x", type: "commit", url: "/", read: true } : null; },
    updateMany: async (filter, update) => { calls.push(["all", filter, update]); return { modifiedCount: 2 }; },
    deleteOne: async (filter) => { calls.push(["delete", filter]); return { deletedCount: filter.recipient === watcher ? 1 : 0 }; },
    deleteMany: async (filter) => { calls.push(["delete-read", filter]); return { deletedCount: 2 }; },
  };
  const controller = createNotificationController({ NotificationModel: model });
  const res = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  let output = res(); await controller.unreadCount({ user: { id: watcher } }, output); assert.equal(output.body.unreadCount, 3);
  output = res(); await controller.readOne({ user: { id: watcher }, params: { id: "507f1f77bcf86cd799439099" } }, output); assert.equal(output.statusCode, 200);
  output = res(); await controller.readAll({ user: { id: watcher } }, output); assert.equal(output.body.updated, 2);
  output = res(); await controller.removeOne({ user: { id: watcher }, params: { id: "507f1f77bcf86cd799439099" } }, output); assert.equal(output.statusCode, 200);
  output = res(); await controller.removeRead({ user: { id: watcher } }, output); assert.equal(output.body.deleted, 2);
  assert.ok(calls.every((call) => !call[1]?.recipient || call[1].recipient === watcher));
});

test("a user cannot mark or delete another user's notification", async () => {
  const model = { findOneAndUpdate: async () => null, deleteOne: async () => ({ deletedCount: 0 }) };
  const controller = createNotificationController({ NotificationModel: model });
  const makeRes = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  let res = makeRes(); await controller.readOne({ user: { id: actor }, params: { id: "507f1f77bcf86cd799439099" } }, res); assert.equal(res.statusCode, 404);
  res = makeRes(); await controller.removeOne({ user: { id: actor }, params: { id: "507f1f77bcf86cd799439099" } }, res); assert.equal(res.statusCode, 404);
});
