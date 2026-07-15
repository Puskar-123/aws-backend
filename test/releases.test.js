const assert = require("node:assert/strict");
const test = require("node:test");
const Tag = require("../models/tagModel");
const Release = require("../models/releaseModel");
const { NOTIFICATION_TYPES } = require("../models/notificationModel");
const { canManageReleases, cleanText, safeRelease, sha256, validateAssetFile } = require("../services/releaseService");
const { buildSourceArchive, safeArchivePrefix, storageBody } = require("../services/sourceArchiveService");
const { normalizeTagName, resolveTagTarget, safeTag, validateTagName } = require("../services/tagService");

const repository = (overrides = {}) => ({
  _id: "507f1f77bcf86cd799439011", name: "sample", owner: "507f1f77bcf86cd799439012", collaborators: [],
  branches: [{ name: "main", head: "abc123", isDefault: true }],
  commits: [
    { hash: "abc123", message: "Initial", time: new Date("2025-01-01"), snapshot: [
      { path: "README.md", s3Key: "commits/abc/README.md" },
      { path: ".env", s3Key: "commits/abc/.env" },
      { path: "node_modules/pkg.js", s3Key: "commits/abc/node_modules/pkg.js" },
    ] },
    { hash: "abcdef", message: "Second", parent: "abc123", files: [{ path: "src/app.js", s3Key: "commits/def/app.js", status: "added" }] },
  ], ...overrides,
});

test("tag names normalize for case-insensitive uniqueness", () => {
  assert.equal(validateTagName("v1.2.0/rc-1"), "v1.2.0/rc-1");
  assert.equal(normalizeTagName("V1.2.0"), "v1.2.0");
});

test("unsafe and malformed tag names are rejected", () => {
  for (const value of ["", "../prod", "v1//x", "/root", "v1@{x}", "tag with spaces"]) assert.throws(() => validateTagName(value));
});

test("tag targets resolve branches and exact commits to canonical hashes", () => {
  const repo = repository();
  assert.equal(resolveTagTarget(repo, "main").hash, "abc123");
  assert.equal(resolveTagTarget(repo, "abcdef").hash, "abcdef");
});

test("unique commit prefixes resolve while ambiguous prefixes conflict", () => {
  const repo = repository();
  assert.equal(resolveTagTarget(repo, "abcd").hash, "abcdef");
  assert.throws(() => resolveTagTarget(repo, "abc"), (error) => error.status === 409 && error.code === "AMBIGUOUS_TAG_TARGET");
});

test("missing commits and empty branches cannot be tagged", () => {
  assert.throws(() => resolveTagTarget(repository(), "missing"), (error) => error.status === 404);
  assert.throws(() => resolveTagTarget(repository({ branches: [{ name: "empty", head: null }] }), "empty"), (error) => error.code === "EMPTY_TAG_TARGET");
});

test("safe tag responses expose commit metadata without repository internals", () => {
  const value = safeTag({ _id: "tag", name: "v1", targetCommitHash: "abc123", createdBy: { username: "ada" } }, repository());
  assert.equal(value.target.message, "Initial");
  assert.equal(value.target.hash, "abc123");
  assert.equal(value.normalizedName, undefined);
});

test("only owners and maintainers can manage releases", () => {
  const repo = repository({ collaborators: [{ user: "maintainer", role: "maintainer" }, { user: "writer", role: "write" }] });
  assert.equal(canManageReleases(repo, repo.owner), true);
  assert.equal(canManageReleases(repo, "maintainer"), true);
  assert.equal(canManageReleases(repo, "writer"), false);
  assert.equal(canManageReleases(repo, "anonymous"), false);
});

test("release text validation requires titles and caps notes", () => {
  assert.equal(cleanText(" Release 1 ", 200, "title", { required: true }), "Release 1");
  assert.throws(() => cleanText(" ", 200, "title", { required: true }));
  assert.throws(() => cleanText("x".repeat(11), 10, "body"));
});

test("asset validation enforces safe names, sizes, duplicates, and file count", () => {
  assert.equal(validateAssetFile({ originalname: "bundle.zip", size: 10, mimetype: "application/zip" }).name, "bundle.zip");
  assert.equal(validateAssetFile({ originalname: "installer.exe", size: 10 }).name, "installer.exe");
  assert.throws(() => validateAssetFile({ originalname: ".env", size: 1 }));
  assert.throws(() => validateAssetFile({ originalname: "install.ps1", size: 1 }));
  assert.throws(() => validateAssetFile({ originalname: "bundle.zip", size: 0 }));
  assert.throws(() => validateAssetFile({ originalname: "BUNDLE.ZIP", size: 1 }, [{ name: "bundle.zip", size: 1 }]));
  assert.throws(() => validateAssetFile({ originalname: "new.zip", size: 1 }, Array.from({ length: 20 }, (_, i) => ({ name: `${i}.zip`, size: 1 }))));
});

test("asset checksums are deterministic SHA-256 values", () => {
  assert.equal(sha256(Buffer.from("CodeHub")), "0b26638585c4664140f285729b41c6be66da279bbecbbebf06471f3b194e6029");
});

test("safe releases never expose raw storage keys", () => {
  const value = safeRelease({ _id: "release", title: "One", assets: [{ _id: "asset", name: "a.zip", size: 2, storageKey: "private/key", checksum: "abc" }] });
  assert.equal(value.assets[0].name, "a.zip");
  assert.equal(value.assets[0].storageKey, undefined);
});

test("tag and release schemas declare repository-scoped uniqueness", () => {
  assert.ok(Tag.schema.indexes().some(([fields, options]) => fields.repository === 1 && fields.normalizedName === 1 && options.unique));
  assert.ok(Release.schema.indexes().some(([fields, options]) => fields.repository === 1 && fields.tag === 1 && options.unique));
});

test("release-published is a supported notification type", () => assert.ok(NOTIFICATION_TYPES.includes("release_published")));

test("archive prefixes remove path separators and unsafe punctuation", () => assert.equal(safeArchivePrefix("my repo", "v1/rc"), "my-repo-v1-rc"));

test("storage bodies accept bytes and reject unknown response shapes", () => {
  assert.equal(storageBody("hello").toString(), "hello");
  assert.throws(() => storageBody({ stream: true }));
});

test("source ZIP uses the tagged snapshot and excludes protected and ignored paths", async () => {
  const repo = repository();
  const requested = [];
  const s3 = { getObject({ Key }) { requested.push(Key); return { promise: async () => ({ Body: Buffer.from(Key) }) }; } };
  const archive = await buildSourceArchive({ repository: repo, descriptor: { id: "abc123", index: 0, commit: repo.commits[0] }, tagName: "v1.0.0", s3, bucket: "bucket" });
  assert.deepEqual(requested, ["commits/abc/README.md"]);
  assert.equal(archive.fileCount, 1);
  assert.equal(archive.body.subarray(0, 2).toString(), "PK");
  assert.equal(archive.filename, "sample-v1.0.0.zip");
});

test("release and tag routes are registered before the generic repository route", () => {
  const paths = require("../routes/repo.router").stack.map((layer) => layer.route?.path).filter(Boolean);
  const generic = paths.indexOf("/:id");
  for (const route of ["/:id/tags", "/:id/tags/:tagName", "/:id/releases", "/:id/releases/latest", "/:id/releases/:releaseId/publish", "/:id/releases/:releaseId/assets"]) {
    assert.ok(paths.includes(route)); assert.ok(paths.indexOf(route) < generic);
  }
});

test("controller lifecycle creates a draft, edits, publishes idempotently, uploads/downloads/deletes an asset, then deletes the release", async () => {
  const controller = require("../controllers/releaseController");
  const { s3 } = require("../config/aws-config");
  const repositoryId = "507f1f77bcf86cd799439011";
  const ownerId = "507f1f77bcf86cd799439012";
  const tagId = "507f1f77bcf86cd799439013";
  const releaseId = "507f1f77bcf86cd799439014";
  const repo = repository({ _id: repositoryId, owner: ownerId, watchers: [] });
  const tag = { _id: tagId, name: "v1.0.0", targetCommitHash: "abc123", message: "Stable" };
  const assets = [];
  assets.id = (id) => assets.find((asset) => String(asset._id) === String(id));
  assets.pull = (id) => { const index = assets.findIndex((asset) => String(asset._id) === String(id)); if (index >= 0) assets.splice(index, 1); };
  const release = {
    _id: releaseId, repository: repositoryId, tag, title: "One", body: "Notes", draft: true,
    prerelease: false, latest: false, publishedAt: null, createdBy: ownerId, assets,
    createdAt: new Date(), updatedAt: new Date(), async save() { this.saved = true; return this; },
    async deleteOne() { this.deleted = true; },
    toObject() { return { ...this, assets: [...this.assets] }; },
  };
  const query = (value) => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, then(resolve) { return Promise.resolve(value).then(resolve); } });
  const originals = {
    tagFindOne: Tag.findOne, releaseCreate: Release.create, releaseFindById: Release.findById,
    releaseFindOne: Release.findOne, releaseUpdateMany: Release.updateMany, releaseUpdateOne: Release.updateOne,
    upload: s3.upload, getObject: s3.getObject, deleteObject: s3.deleteObject,
  };
  Tag.findOne = async () => tag;
  Release.create = async (input) => { Object.assign(release, input, { tag }); return release; };
  Release.findById = () => query(release);
  Release.findOne = (filter) => query(filter?._id || release.draft === false ? release : null);
  Release.updateMany = async () => ({ modifiedCount: 1 });
  Release.updateOne = async () => ({ modifiedCount: 1 });
  const stored = new Map();
  s3.upload = ({ Key, Body }) => ({ promise: async () => { stored.set(Key, Buffer.from(Body)); return {}; } });
  s3.getObject = ({ Key }) => ({ promise: async () => ({ Body: stored.get(Key) }) });
  s3.deleteObject = ({ Key }) => ({ promise: async () => { stored.delete(Key); return {}; } });
  const response = () => ({ statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set(name, value) { this.headers[name] = value; return this; }, send(body) { this.sent = body; return this; } });
  const baseReq = { repository: repo, user: { id: ownerId }, params: { id: repositoryId, releaseId }, body: {} };
  try {
    const created = response();
    await controller.create({ ...baseReq, body: { tagId, title: "CodeHub 1.0", body: "First notes", draft: true } }, created);
    assert.equal(created.statusCode, 201); assert.equal(created.body.release.draft, true);

    const edited = response();
    await controller.update({ ...baseReq, body: { title: "CodeHub 1.0.1", body: "Corrected notes", prerelease: true } }, edited);
    assert.equal(edited.body.release.title, "CodeHub 1.0.1"); assert.equal(edited.body.release.prerelease, true);

    const published = response(); await controller.publish(baseReq, published);
    assert.equal(published.body.idempotent, false); assert.ok(release.publishedAt);
    const repeated = response(); await controller.publish(baseReq, repeated);
    assert.equal(repeated.body.idempotent, true);

    const uploaded = response();
    await controller.uploadAsset({ ...baseReq, file: { originalname: "bundle.zip", size: 7, mimetype: "application/zip", buffer: Buffer.from("archive") } }, uploaded);
    assert.equal(uploaded.statusCode, 201); assert.equal(assets.length, 1); assert.equal(stored.size, 1);
    const assetId = String(assets[0]._id);

    const downloaded = response();
    await controller.downloadAsset({ ...baseReq, params: { ...baseReq.params, assetId } }, downloaded);
    assert.equal(downloaded.sent.toString(), "archive"); assert.match(downloaded.headers["Content-Disposition"], /bundle.zip/);

    const assetDeleted = response();
    await controller.deleteAsset({ ...baseReq, params: { ...baseReq.params, assetId } }, assetDeleted);
    assert.equal(assets.length, 0); assert.equal(stored.size, 0);

    const removed = response(); await controller.remove(baseReq, removed);
    assert.equal(release.deleted, true); assert.equal(removed.body.message, "Release deleted");
  } finally {
    Tag.findOne = originals.tagFindOne; Release.create = originals.releaseCreate; Release.findById = originals.releaseFindById;
    Release.findOne = originals.releaseFindOne; Release.updateMany = originals.releaseUpdateMany; Release.updateOne = originals.releaseUpdateOne;
    s3.upload = originals.upload; s3.getObject = originals.getObject; s3.deleteObject = originals.deleteObject;
  }
});
