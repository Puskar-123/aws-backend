const Notification = require("../models/notificationModel");
const User = require("../models/userModel");

const idOf = (value) => String(value?._id || value?.id || value || "");
const clean = (value, max) => String(value || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

async function createNotification(input, { NotificationModel = Notification } = {}) {
  const recipient = idOf(input.recipient);
  const actor = idOf(input.actor);
  if (!recipient || (actor && recipient === actor)) return null;
  try {
    return await NotificationModel.create({
      recipient,
      actor: actor || null,
      repository: input.repository || null,
      type: input.type,
      title: clean(input.title, 300),
      message: clean(input.message, 1000),
      url: String(input.url || "/notifications").slice(0, 1000),
      metadata: input.metadata || {},
      eventKey: input.eventKey || null,
    });
  } catch (error) {
    if (error?.code !== 11000) console.error("Notification insert failed:", error.message);
    return null;
  }
}

async function notifyRepositoryWatchers(repository, input, {
  NotificationModel = Notification,
  UserModel = User,
} = {}) {
  const actor = idOf(input.actor);
  let recipients = [...new Set((repository?.watchers || []).map(idOf).filter((id) => id && id !== actor))];
  if (repository?.visibility === "private") {
    const owner = idOf(repository.owner);
    const allowed = new Set([owner, ...(repository.collaborators || []).map((item) => idOf(item.user))]);
    recipients = recipients.filter((id) => allowed.has(id));
  }
  if (!recipients.length) return [];
  try {
    const existingUsers = await UserModel.find({ _id: { $in: recipients } }).distinct("_id");
    const valid = new Set(existingUsers.map(idOf));
    const documents = recipients.filter((id) => valid.has(id)).map((recipient) => ({
      recipient,
      actor: actor || null,
      repository: repository._id,
      type: input.type,
      title: clean(input.title, 300),
      message: clean(input.message, 1000),
      url: String(input.url || `/repo/${repository._id}`).slice(0, 1000),
      metadata: input.metadata || {},
      eventKey: input.eventKey ? `${input.eventKey}:${recipient}` : null,
    }));
    if (!documents.length) return [];
    return await NotificationModel.insertMany(documents, { ordered: false });
  } catch (error) {
    if (error?.code !== 11000 && !error?.writeErrors?.every((item) => item.code === 11000)) {
      console.error(`Watcher notification failed for repository ${idOf(repository)}:`, error.message);
    }
    return [];
  }
}

async function safeNotifyRepositoryWatchers(repository, input, dependencies) {
  try { return await notifyRepositoryWatchers(repository, input, dependencies); }
  catch (error) {
    console.error(`Notification isolation caught repository ${idOf(repository)}:`, error.message);
    return [];
  }
}

const markAsRead = (recipient, id, { NotificationModel = Notification } = {}) =>
  NotificationModel.findOneAndUpdate(
    { _id: id, recipient },
    { $set: { read: true, readAt: new Date() } },
    { new: true },
  );

const markAllAsRead = (recipient, { NotificationModel = Notification } = {}) =>
  NotificationModel.updateMany({ recipient, read: false }, { $set: { read: true, readAt: new Date() } });

module.exports = {
  createNotification,
  markAllAsRead,
  markAsRead,
  notifyRepositoryWatchers,
  safeNotifyRepositoryWatchers,
};
