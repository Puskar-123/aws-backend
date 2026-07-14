const mongoose = require("mongoose");
const Notification = require("../models/notificationModel");
const { markAllAsRead, markAsRead } = require("../services/notificationService");

const identityFields = "_id username name avatarUrl";
const repositoryFields = "_id name visibility owner collaborators";
const idOf = (value) => String(value?._id || value?.id || value || "");

function safeNotification(document, recipientId) {
  const value = document?.toObject ? document.toObject() : document;
  if (!value) return null;
  const repository = value.repository;
  const accessNotification = ["repository_invitation", "collaborator_removed", "collaborator_role_changed"].includes(value.type);
  const privateAccess = idOf(repository?.owner) === String(recipientId)
    || (repository?.collaborators || []).some((item) => idOf(item.user) === String(recipientId));
  if (repository?.visibility === "private" && !privateAccess && !accessNotification) return null;
  return {
    _id: value._id,
    type: value.type,
    title: value.title,
    message: value.message || "",
    url: value.url,
    read: Boolean(value.read),
    readAt: value.readAt || null,
    createdAt: value.createdAt,
    actor: value.actor && typeof value.actor === "object" ? {
      _id: value.actor._id,
      username: value.actor.username || "",
      name: value.actor.name || "",
      avatarUrl: value.actor.avatarUrl || "",
    } : null,
    repository: repository && typeof repository === "object" ? {
      _id: repository._id,
      name: repository.name || "",
    } : null,
  };
}

function createNotificationController({ NotificationModel = Notification } = {}) {
  async function list(req, res) {
    try {
      const recipient = req.user.id;
      const status = String(req.query.status || "all").toLowerCase();
      if (!['all', 'unread'].includes(status)) return res.status(400).json({ error: "Invalid notification status" });
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const filter = { recipient, ...(status === "unread" ? { read: false } : {}) };
      if (req.query.type) {
        const requested = String(req.query.type).toLowerCase();
        filter.type = requested === "issue" ? /^issue_/ : requested === "pull_request" ? /^pull_request_/ : requested;
      }
      const [documents, total, unreadCount] = await Promise.all([
        NotificationModel.find(filter).populate("actor", identityFields).populate("repository", repositoryFields)
          .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        NotificationModel.countDocuments(filter),
        NotificationModel.countDocuments({ recipient, read: false }),
      ]);
      return res.json({
        notifications: documents.map((item) => safeNotification(item, recipient)).filter(Boolean),
        unreadCount,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (error) {
      console.error("Notification list failed:", error.message);
      return res.status(500).json({ error: "Unable to load notifications" });
    }
  }

  async function unreadCount(req, res) {
    try {
      const count = await NotificationModel.countDocuments({ recipient: req.user.id, read: false });
      return res.json({ unreadCount: count });
    } catch { return res.status(500).json({ error: "Unable to load unread count" }); }
  }

  async function readOne(req, res) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid notification ID" });
    const notification = await markAsRead(req.user.id, req.params.id, { NotificationModel });
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    return res.json({ message: "Notification marked as read", notification: safeNotification(notification, req.user.id) });
  }

  async function readAll(req, res) {
    const result = await markAllAsRead(req.user.id, { NotificationModel });
    return res.json({ message: "Notifications marked as read", updated: result.modifiedCount || 0 });
  }

  async function removeOne(req, res) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid notification ID" });
    const result = await NotificationModel.deleteOne({ _id: req.params.id, recipient: req.user.id });
    if (!result.deletedCount) return res.status(404).json({ error: "Notification not found" });
    return res.json({ message: "Notification deleted" });
  }

  async function removeRead(req, res) {
    const result = await NotificationModel.deleteMany({ recipient: req.user.id, read: true });
    return res.json({ message: "Read notifications deleted", deleted: result.deletedCount || 0 });
  }

  return { list, readAll, readOne, removeOne, removeRead, unreadCount };
}

module.exports = { createNotificationController, safeNotification, ...createNotificationController() };
