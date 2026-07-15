const Tag = require("../models/tagModel");
const Release = require("../models/releaseModel");
const { canManageReleases, releaseError } = require("../services/releaseService");
const { normalizeTagName, resolveTagTarget, safeTag, validateTagName } = require("../services/tagService");

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pagination = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 30));
  return { page, limit, skip: (page - 1) * limit };
};
const sendError = (res, error) => res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to manage tags", code: error.code });

async function list(req, res) {
  try {
    const { page, limit, skip } = pagination(req.query || {});
    const filter = { repository: req.repository._id };
    if (req.query?.search) filter.name = { $regex: escapeRegex(String(req.query.search).slice(0, 100)), $options: "i" };
    const sorts = { "created-desc": { createdAt: -1, _id: -1 }, "created-asc": { createdAt: 1, _id: 1 }, "name-asc": { normalizedName: 1, _id: 1 }, "name-desc": { normalizedName: -1, _id: -1 } };
    const sort = sorts[req.query?.sort] || sorts["created-desc"];
    const [tags, total, releases] = await Promise.all([
      Tag.find(filter).sort(sort).skip(skip).limit(limit).populate("createdBy", "_id username name avatarUrl").lean(),
      Tag.countDocuments(filter),
      Release.find({ repository: req.repository._id, ...(canManageReleases(req.repository, req.user?.id) ? {} : { draft: false }) }).select("tag draft prerelease latest publishedAt").lean(),
    ]);
    const byTag = new Map(releases.map((release) => [String(release.tag), release]));
    return res.json({
      tags: tags.map((tag) => ({ ...safeTag(tag, req.repository), release: byTag.get(String(tag._id)) || null })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      canManage: canManageReleases(req.repository, req.user?.id),
    });
  } catch (error) { return sendError(res, error); }
}

async function details(req, res) {
  try {
    const tag = await Tag.findOne({ repository: req.repository._id, normalizedName: normalizeTagName(decodeURIComponent(req.params.tagName)) }).populate("createdBy", "_id username name avatarUrl").lean();
    if (!tag) throw releaseError(404, "Tag not found", "TAG_NOT_FOUND");
    const release = await Release.findOne({ repository: req.repository._id, tag: tag._id, ...(canManageReleases(req.repository, req.user?.id) ? {} : { draft: false }) }).select("_id title draft prerelease latest publishedAt").lean();
    return res.json({ tag: { ...safeTag(tag, req.repository), release: release || null }, canManage: canManageReleases(req.repository, req.user?.id) });
  } catch (error) { return sendError(res, error); }
}

async function create(req, res) {
  try {
    if (!canManageReleases(req.repository, req.user?.id)) throw releaseError(403, "Owner or maintainer access is required", "TAG_PERMISSION_DENIED");
    const name = validateTagName(req.body?.name);
    const { hash } = resolveTagTarget(req.repository, req.body?.target);
    const tag = await Tag.create({
      repository: req.repository._id, name, normalizedName: normalizeTagName(name), targetCommitHash: hash,
      message: String(req.body?.message || "").trim().slice(0, 2000), createdBy: req.user.id,
    });
    return res.status(201).json({ message: "Tag created", tag: safeTag(tag, req.repository) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: "A tag with this name already exists", code: "DUPLICATE_TAG" });
    return sendError(res, error);
  }
}

async function update(req, res) {
  try {
    if (!canManageReleases(req.repository, req.user?.id)) throw releaseError(403, "Owner or maintainer access is required", "TAG_PERMISSION_DENIED");
    const tag = await Tag.findOne({ repository: req.repository._id, normalizedName: normalizeTagName(decodeURIComponent(req.params.tagName)) });
    if (!tag) throw releaseError(404, "Tag not found", "TAG_NOT_FOUND");
    if (req.body?.target !== undefined) tag.targetCommitHash = resolveTagTarget(req.repository, req.body.target).hash;
    if (req.body?.message !== undefined) tag.message = String(req.body.message || "").trim().slice(0, 2000);
    await tag.save();
    return res.json({ message: "Tag updated", tag: safeTag(tag, req.repository) });
  } catch (error) { return sendError(res, error); }
}

async function remove(req, res) {
  try {
    if (!canManageReleases(req.repository, req.user?.id)) throw releaseError(403, "Owner or maintainer access is required", "TAG_PERMISSION_DENIED");
    const tag = await Tag.findOne({ repository: req.repository._id, normalizedName: normalizeTagName(decodeURIComponent(req.params.tagName)) });
    if (!tag) throw releaseError(404, "Tag not found", "TAG_NOT_FOUND");
    if (await Release.exists({ repository: req.repository._id, tag: tag._id })) throw releaseError(409, "This tag is used by a release. Delete the release first.", "TAG_IN_USE");
    await tag.deleteOne();
    return res.json({ message: "Tag deleted" });
  } catch (error) { return sendError(res, error); }
}

module.exports = { create, details, list, pagination, remove, update };
