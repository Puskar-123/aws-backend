const mongoose = require("mongoose");
const Tag = require("../models/tagModel");
const Release = require("../models/releaseModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { safeNotifyRepositoryWatchers } = require("../services/notificationService");
const { buildSourceArchive } = require("../services/sourceArchiveService");
const { findCommitDescriptor } = require("../services/snapshotService");
const { normalizeTagName, resolveTagTarget, safeTag, validateTagName } = require("../services/tagService");
const {
  assertReleaseManager, canManageReleases, cleanText, releaseError, safeRelease, sha256, validateAssetFile,
} = require("../services/releaseService");

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sendError = (res, error, fallback = "Unable to manage releases") => res.status(error.status || 500).json({ error: error.status ? error.message : fallback, code: error.code });
const pagination = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
};
const populated = (query) => query.populate("tag", "name targetCommitHash message").populate("createdBy", "_id username name avatarUrl").populate("publishedBy", "_id username name avatarUrl").populate("assets.uploadedBy", "_id username name avatarUrl");

async function findVisibleRelease(req, { includeKeys = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(req.params.releaseId)) throw releaseError(400, "Invalid release ID", "INVALID_RELEASE_ID");
  let query = Release.findOne({ _id: req.params.releaseId, repository: req.repository._id });
  if (includeKeys) query = query.select("+assets.storageKey");
  const release = await populated(query);
  if (!release) throw releaseError(404, "Release not found", "RELEASE_NOT_FOUND");
  if (release.draft && !canManageReleases(req.repository, req.user?.id)) throw releaseError(404, "Release not found", "RELEASE_NOT_FOUND");
  return release;
}

async function refreshLatest(repositoryId) {
  await Release.updateMany({ repository: repositoryId, latest: true }, { $set: { latest: false } });
  const latest = await Release.findOne({ repository: repositoryId, draft: false, prerelease: false, publishedAt: { $ne: null } }).sort({ publishedAt: -1, _id: -1 });
  if (latest) { latest.latest = true; await latest.save(); }
  return latest;
}

async function notifyPublished(repository, release, actor) {
  await safeNotifyRepositoryWatchers(repository, {
    actor: actor || release.createdBy?._id || release.createdBy,
    type: "release_published", title: `New ${release.prerelease ? "prerelease" : "release"}: ${release.title}`,
    message: `${repository.name} published ${release.prerelease ? "prerelease" : "release"} ${release.tag?.name || ""}`.trim(),
    url: `/repo/${repository._id}/releases/${release._id}`,
    metadata: { releaseId: release._id, tag: release.tag?.name }, eventKey: `release-published:${release._id}`,
  });
}

async function list(req, res) {
  try {
    const { page, limit, skip } = pagination(req.query || {});
    const manager = canManageReleases(req.repository, req.user?.id);
    const filter = { repository: req.repository._id };
    if (!manager || req.query?.draft === "false") filter.draft = false;
    else if (req.query?.draft === "true") filter.draft = true;
    if (req.query?.prerelease === "true") filter.prerelease = true;
    if (req.query?.prerelease === "false") filter.prerelease = false;
    if (req.query?.search) filter.$or = [
      { title: { $regex: escapeRegex(String(req.query.search).slice(0, 100)), $options: "i" } },
      { body: { $regex: escapeRegex(String(req.query.search).slice(0, 100)), $options: "i" } },
    ];
    const [items, total, counts] = await Promise.all([
      populated(Release.find(filter).sort({ latest: -1, publishedAt: -1, createdAt: -1, _id: -1 }).skip(skip).limit(limit)).lean(),
      Release.countDocuments(filter),
      Release.aggregate([{ $match: { repository: req.repository._id, ...(manager ? {} : { draft: false }) } }, { $group: { _id: "$draft", count: { $sum: 1 } } }]),
    ]);
    return res.json({ releases: items.map(safeRelease), pagination: { page, limit, total, pages: Math.ceil(total / limit) }, counts: { published: counts.find((x) => x._id === false)?.count || 0, drafts: manager ? counts.find((x) => x._id === true)?.count || 0 : 0 }, canManage: manager });
  } catch (error) { return sendError(res, error); }
}

async function details(req, res) {
  try { const release = await findVisibleRelease(req); return res.json({ release: safeRelease(release), canManage: canManageReleases(req.repository, req.user?.id) }); }
  catch (error) { return sendError(res, error); }
}

async function latest(req, res) {
  try {
    const release = await populated(Release.findOne({ repository: req.repository._id, draft: false, prerelease: false, publishedAt: { $ne: null } }).sort({ publishedAt: -1, _id: -1 }));
    if (!release) throw releaseError(404, "No stable release has been published", "RELEASE_NOT_FOUND");
    return res.json({ release: safeRelease(release) });
  } catch (error) { return sendError(res, error); }
}

async function resolveOrCreateTag(req) {
  if (req.body?.tagId) {
    if (!mongoose.Types.ObjectId.isValid(req.body.tagId)) throw releaseError(400, "Invalid tag ID", "INVALID_TAG_ID");
    const tag = await Tag.findOne({ _id: req.body.tagId, repository: req.repository._id });
    if (!tag) throw releaseError(404, "Tag not found", "TAG_NOT_FOUND");
    return { tag, created: false };
  }
  const input = req.body?.newTag;
  if (!input) throw releaseError(400, "Select a tag or create a new tag", "TAG_REQUIRED");
  const name = validateTagName(input.name);
  const targetCommitHash = resolveTagTarget(req.repository, input.target).hash;
  try {
    const tag = await Tag.create({ repository: req.repository._id, name, normalizedName: normalizeTagName(name), targetCommitHash, message: String(input.message || "").trim().slice(0, 2000), createdBy: req.user.id });
    return { tag, created: true };
  } catch (error) {
    if (error.code === 11000) throw releaseError(409, "A tag with this name already exists", "DUPLICATE_TAG");
    throw error;
  }
}

async function create(req, res) {
  let createdTag;
  try {
    assertReleaseManager(req.repository, req.user?.id);
    const resolved = await resolveOrCreateTag(req); createdTag = resolved.created ? resolved.tag : null;
    const draft = req.body?.draft !== false;
    let release = await Release.create({
      repository: req.repository._id, tag: resolved.tag._id,
      title: cleanText(req.body?.title || resolved.tag.name, 200, "title", { required: true }),
      body: cleanText(req.body?.body, 100000, "body"), draft,
      prerelease: Boolean(req.body?.prerelease), publishedAt: draft ? null : new Date(), publishedBy: draft ? null : req.user.id, createdBy: req.user.id,
    });
    createdTag = null;
    if (!draft) await refreshLatest(req.repository._id);
    release = await populated(Release.findById(release._id));
    if (!draft) await notifyPublished(req.repository, release, req.user.id);
    return res.status(201).json({ message: draft ? "Draft release created" : "Release published", release: safeRelease(release) });
  } catch (error) {
    if (createdTag) await Tag.deleteOne({ _id: createdTag._id }).catch(() => {});
    if (error?.code === 11000) return res.status(409).json({ error: "This tag already has a release", code: "DUPLICATE_RELEASE_TAG" });
    return sendError(res, error);
  }
}

async function update(req, res) {
  try {
    assertReleaseManager(req.repository, req.user?.id);
    const release = await findVisibleRelease(req);
    if (req.body?.title !== undefined) release.title = cleanText(req.body.title, 200, "title", { required: true });
    if (req.body?.body !== undefined) release.body = cleanText(req.body.body, 100000, "body");
    if (req.body?.prerelease !== undefined) release.prerelease = Boolean(req.body.prerelease);
    await release.save();
    if (!release.draft) await refreshLatest(req.repository._id);
    return res.json({ message: "Release updated", release: safeRelease(await populated(Release.findById(release._id))) });
  } catch (error) { return sendError(res, error); }
}

async function publish(req, res) {
  try {
    assertReleaseManager(req.repository, req.user?.id);
    let release = await findVisibleRelease(req);
    if (!release.draft) return res.json({ message: "Release is already published", idempotent: true, release: safeRelease(release) });
    if (!release.tag || !findCommitDescriptor(req.repository, release.tag.targetCommitHash)) throw releaseError(409, "The release tag or target commit is no longer available", "TAG_TARGET_UNAVAILABLE");
    release.draft = false; release.publishedAt = new Date(); release.publishedBy = req.user.id; await release.save();
    await refreshLatest(req.repository._id);
    release = await populated(Release.findById(release._id));
    await notifyPublished(req.repository, release, req.user.id);
    return res.json({ message: "Release published", idempotent: false, release: safeRelease(release) });
  } catch (error) { return sendError(res, error); }
}

async function remove(req, res) {
  try {
    assertReleaseManager(req.repository, req.user?.id);
    const release = await findVisibleRelease(req, { includeKeys: true });
    await Promise.all((release.assets || []).map((asset) => s3.deleteObject({ Bucket: S3_BUCKET, Key: asset.storageKey }).promise()));
    await release.deleteOne(); await refreshLatest(req.repository._id);
    return res.json({ message: "Release deleted" });
  } catch (error) { return sendError(res, error); }
}

async function uploadAsset(req, res) {
  try {
    assertReleaseManager(req.repository, req.user?.id);
    if (!req.file) throw releaseError(400, "Choose an asset to upload", "ASSET_REQUIRED");
    const release = await findVisibleRelease(req, { includeKeys: true });
    const metadata = validateAssetFile(req.file, release.assets || []);
    const assetId = new mongoose.Types.ObjectId();
    const key = `releases/${req.repository._id}/${release._id}/${assetId}`;
    await s3.upload({ Bucket: S3_BUCKET, Key: key, Body: req.file.buffer, ContentType: metadata.contentType, Metadata: { filename: encodeURIComponent(metadata.name) } }).promise();
    release.assets.push({ _id: assetId, ...metadata, storageKey: key, checksum: sha256(req.file.buffer), uploadedBy: req.user.id });
    try { await release.save(); } catch (error) { await s3.deleteObject({ Bucket: S3_BUCKET, Key: key }).promise().catch(() => null); throw error; }
    const saved = release.assets.id(assetId);
    return res.status(201).json({ message: "Asset uploaded", asset: safeRelease({ assets: [saved] }).assets[0] });
  } catch (error) { return sendError(res, error, "Unable to upload asset"); }
}

async function downloadAsset(req, res) {
  try {
    const release = await findVisibleRelease(req, { includeKeys: true });
    const asset = release.assets.id(req.params.assetId);
    if (!asset) throw releaseError(404, "Asset not found", "ASSET_NOT_FOUND");
    const object = await s3.getObject({ Bucket: S3_BUCKET, Key: asset.storageKey }).promise();
    await Release.updateOne({ _id: release._id, "assets._id": asset._id }, { $inc: { "assets.$.downloadCount": 1 } });
    res.set("Content-Type", asset.contentType || "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
    res.set("Content-Length", String(object.Body.length));
    return res.send(object.Body);
  } catch (error) { return sendError(res, error, "Unable to download asset"); }
}

async function deleteAsset(req, res) {
  try {
    assertReleaseManager(req.repository, req.user?.id);
    const release = await findVisibleRelease(req, { includeKeys: true });
    const asset = release.assets.id(req.params.assetId);
    if (!asset) throw releaseError(404, "Asset not found", "ASSET_NOT_FOUND");
    await s3.deleteObject({ Bucket: S3_BUCKET, Key: asset.storageKey }).promise();
    release.assets.pull(asset._id); await release.save();
    return res.json({ message: "Asset deleted" });
  } catch (error) { return sendError(res, error, "Unable to delete asset"); }
}

async function sourceArchive(req, res) {
  try {
    let tag;
    if (req.params.releaseId) tag = (await findVisibleRelease(req)).tag;
    else tag = await Tag.findOne({ repository: req.repository._id, normalizedName: normalizeTagName(decodeURIComponent(req.params.tagName)) });
    if (!tag) throw releaseError(404, "Tag not found", "TAG_NOT_FOUND");
    const descriptor = findCommitDescriptor(req.repository, tag.targetCommitHash);
    if (!descriptor) throw releaseError(409, "The tagged commit is no longer available", "TAG_TARGET_UNAVAILABLE");
    const archive = await buildSourceArchive({ repository: req.repository, descriptor, tagName: tag.name, s3, bucket: S3_BUCKET });
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(archive.filename)}`);
    res.set("Content-Length", String(archive.body.length));
    return res.send(archive.body);
  } catch (error) { return sendError(res, error, "Unable to build source archive"); }
}

module.exports = { create, deleteAsset, details, downloadAsset, findVisibleRelease, latest, list, pagination, publish, refreshLatest, remove, sourceArchive, update, uploadAsset };
