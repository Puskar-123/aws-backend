const Repository = require("../models/repoModel");
const User = require("../models/userModel");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 100;
const SORTS = new Set(["recent", "stars", "forks", "watchers", "name"]);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeQuery = (value, { required = false, maximum = MAX_QUERY_LENGTH } = {}) => {
  const query = String(value || "").replace(/\s+/g, " ").trim();
  if (required && !query) throw Object.assign(new Error("Search query is required"), { status: 400 });
  if (query.length > maximum) throw Object.assign(new Error(`Search query must be ${maximum} characters or fewer`), { status: 400 });
  return query;
};
const pagination = (query = {}) => ({
  page: Math.max(1, Number.parseInt(query.page, 10) || 1),
  limit: Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_LIMIT)),
});
const sortFor = (sort) => ({
  recent: { updatedAt: -1, _id: -1 },
  stars: { starCount: -1, updatedAt: -1 },
  forks: { forkCount: -1, updatedAt: -1 },
  watchers: { watcherCount: -1, updatedAt: -1 },
  name: { normalizedName: 1, _id: 1 },
}[sort]);

function repositoryPipeline({ q = "", owner = "", language = "", sort = "recent", page = 1, limit = DEFAULT_LIMIT } = {}) {
  const pipeline = [
    { $match: { visibility: "public" } },
    { $lookup: { from: "users", localField: "owner", foreignField: "_id", as: "owner" } },
    { $unwind: "$owner" },
  ];
  const conditions = [];
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    conditions.push({ $or: [{ name: pattern }, { description: pattern }, { "owner.username": pattern }] });
  }
  if (owner) conditions.push({ "owner.username": new RegExp(`^${escapeRegex(owner)}$`, "i") });
  if (language) conditions.push({ language: new RegExp(`^${escapeRegex(language)}$`, "i") });
  if (conditions.length) pipeline.push({ $match: conditions.length === 1 ? conditions[0] : { $and: conditions } });
  pipeline.push(
    { $addFields: {
      starCount: { $size: { $ifNull: ["$stars", []] } },
      forkCount: { $size: { $ifNull: ["$forks", []] } },
      watcherCount: { $size: { $ifNull: ["$watchers", []] } },
      commitCount: { $size: { $ifNull: ["$commits", []] } },
      normalizedName: { $toLower: { $ifNull: ["$name", ""] } },
    } },
    { $sort: sortFor(sort) },
    { $facet: {
      metadata: [{ $count: "total" }],
      repositories: [
        { $skip: (page - 1) * limit }, { $limit: limit },
        { $project: {
          _id: 1, name: 1, description: { $ifNull: ["$description", ""] }, visibility: 1,
          language: { $ifNull: ["$language", ""] }, defaultBranch: { $ifNull: ["$defaultBranch", "main"] },
          starCount: 1, forkCount: 1, watcherCount: 1, commitCount: 1, updatedAt: 1,
          owner: { _id: "$owner._id", username: "$owner.username", avatarUrl: { $ifNull: ["$owner.avatarUrl", ""] } },
        } },
      ],
    } },
  );
  return pipeline;
}

function userPipeline({ q, page, limit }) {
  const pattern = new RegExp(escapeRegex(q), "i");
  return [
    { $match: { $or: [{ username: pattern }, { name: pattern }] } },
    { $sort: { username: 1, _id: 1 } },
    { $facet: {
      metadata: [{ $count: "total" }],
      users: [
        { $skip: (page - 1) * limit }, { $limit: limit },
        { $lookup: { from: "repositories", let: { ownerId: "$_id" }, pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$owner", "$$ownerId"] }, { $eq: ["$visibility", "public"] }] } } },
          { $count: "count" },
        ], as: "publicRepositories" } },
        { $project: {
          _id: 1, username: 1, displayName: { $ifNull: ["$name", ""] },
          avatarUrl: { $ifNull: ["$avatarUrl", ""] }, bio: { $ifNull: ["$bio", ""] },
          publicRepositoryCount: { $ifNull: [{ $arrayElemAt: ["$publicRepositories.count", 0] }, 0] },
        } },
      ],
    } },
  ];
}

const unpack = (result, key) => ({ items: result?.[0]?.[key] || [], total: result?.[0]?.metadata?.[0]?.total || 0 });
const pageInfo = (page, limit, total) => ({ page, limit, total, pages: Math.ceil(total / limit), hasNextPage: page * limit < total, hasPreviousPage: page > 1 });

function createPublicDiscoveryController({ RepoModel = Repository, UserModel = User } = {}) {
  async function explore(req, res) {
    try {
      const q = normalizeQuery(req.query.q);
      const owner = normalizeQuery(req.query.owner, { maximum: 80 });
      const language = normalizeQuery(req.query.language, { maximum: 40 });
      const sort = String(req.query.sort || "recent").toLowerCase();
      if (!SORTS.has(sort)) return res.status(400).json({ error: "Invalid repository sort" });
      const { page, limit } = pagination(req.query);
      const data = unpack(await RepoModel.aggregate(repositoryPipeline({ q, owner, language, sort, page, limit })), "repositories");
      return res.json({ repositories: data.items, pagination: pageInfo(page, limit, data.total) });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Explore query failed:", error.message);
      return res.status(500).json({ error: "Unable to load public repositories" });
    }
  }

  async function search(req, res) {
    try {
      const q = normalizeQuery(req.query.q, { required: true });
      const type = String(req.query.type || "all").toLowerCase();
      if (!new Set(["all", "repositories", "users"]).has(type)) return res.status(400).json({ error: "Invalid search type" });
      const { page, limit } = pagination(req.query);
      const [repoResult, userResult] = await Promise.all([
        type === "users" ? [] : RepoModel.aggregate(repositoryPipeline({ q, page, limit, sort: "recent" })),
        type === "repositories" ? [] : UserModel.aggregate(userPipeline({ q, page, limit })),
      ]);
      const repos = type === "users" ? { items: [], total: 0 } : unpack(repoResult, "repositories");
      const users = type === "repositories" ? { items: [], total: 0 } : unpack(userResult, "users");
      return res.json({
        query: q, repositories: repos.items, users: users.items,
        pagination: {
          repositories: pageInfo(page, limit, repos.total),
          users: pageInfo(page, limit, users.total),
        },
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Global search failed:", error.message);
      return res.status(500).json({ error: "Unable to search CodeHub" });
    }
  }

  async function publicProfile(req, res) {
    try {
      const username = normalizeQuery(req.params.username, { required: true, maximum: 80 });
      const user = await UserModel.findOne({ username: new RegExp(`^${escapeRegex(username)}$`, "i") })
        .select("_id username name avatarUrl bio location website company createdAt followers following followedUsers").lean();
      if (!user) return res.status(404).json({ error: "User not found" });
      const [repositoryResult, starResult] = await Promise.all([
        RepoModel.aggregate(repositoryPipeline({ owner: user.username, sort: "recent", page: 1, limit: 6 })),
        RepoModel.aggregate([
          { $match: { owner: user._id, visibility: "public" } },
          { $project: { stars: { $size: { $ifNull: ["$stars", []] } } } },
          { $group: { _id: null, total: { $sum: "$stars" } } },
        ]),
      ]);
      const result = unpack(repositoryResult, "repositories");
      const stars = starResult?.[0]?.total || 0;
      return res.json({
        user: { _id: user._id, username: user.username, name: user.name || "", displayName: user.name || "", avatarUrl: user.avatarUrl || "", bio: user.bio || "", location: user.location || "", website: user.website || "", company: user.company || "", createdAt: user.createdAt || null, followersCount: user.followers?.length || 0, followingCount: user.following?.length || user.followedUsers?.length || 0 },
        publicRepositoryCount: result.total,
        totalStarsReceived: stars,
        recentRepositories: result.items,
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("Public profile failed:", error.message);
      return res.status(500).json({ error: "Unable to load public profile" });
    }
  }

  async function userRepositories(req, res) {
    try {
      const username = normalizeQuery(req.params.username, { required: true, maximum: 80 });
      const user = await UserModel.findOne({ username: new RegExp(`^${escapeRegex(username)}$`, "i") }).select("_id username").lean();
      if (!user) return res.status(404).json({ error: "User not found" });
      req.query.owner = user.username;
      return explore(req, res);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      return res.status(500).json({ error: "Unable to load public repositories" });
    }
  }

  return { explore, publicProfile, search, userRepositories };
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY_LENGTH, SORTS, createPublicDiscoveryController, escapeRegex, normalizeQuery, pagination, repositoryPipeline, userPipeline, ...createPublicDiscoveryController() };
