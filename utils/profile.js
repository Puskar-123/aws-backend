const { isSensitiveRepoPath } = require("./repoPath");

const PROFILE_FIELDS = {
  name: 80,
  bio: 160,
  avatarUrl: 500,
  location: 100,
  website: 200,
  company: 100,
};

function normalizeVisibility(visibility) {
  const value = String(visibility ?? "").toLowerCase();
  return ["private", "false", "0"].includes(value) ? "private" : "public";
}

function cleanText(value) {
  return String(value).replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function normalizeWebUrl(value, fieldName) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(cleaned) ? cleaned : `https://${cleaned}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    const error = new Error(`${fieldName} must be a valid URL`);
    error.status = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error(`${fieldName} must use http or https`);
    error.status = 400;
    throw error;
  }
  return parsed.toString();
}

function safeStoredUrl(value, fieldName) {
  try { return normalizeWebUrl(value || "", fieldName); } catch { return ""; }
}

function validateProfileUpdate(body = {}) {
  const update = {};
  for (const [field, maxLength] of Object.entries(PROFILE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    if (typeof body[field] !== "string") {
      const error = new Error(`${field} must be text`);
      error.status = 400;
      throw error;
    }
    const value = field === "website" || field === "avatarUrl"
      ? normalizeWebUrl(body[field], field === "website" ? "Website" : "Avatar URL")
      : cleanText(body[field]);
    if (value.length > maxLength) {
      const error = new Error(`${field} must be ${maxLength} characters or fewer`);
      error.status = 400;
      throw error;
    }
    update[field] = value;
  }
  return update;
}

function getRepositoryId(repository) {
  return repository?._id || repository?.id || null;
}

function buildContributions(repositories) {
  const counts = new Map();
  const add = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return;
    const key = date.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const repository of repositories) {
    add(repository.createdAt);
    for (const commit of Array.isArray(repository.commits) ? repository.commits : []) {
      add(commit.time || commit.createdAt);
    }
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildRecentActivity(repositories) {
  const activity = [];
  for (const repository of repositories) {
    const repositoryId = getRepositoryId(repository);
    if (repository.createdAt) {
      activity.push({
        type: "repository",
        repositoryId,
        repositoryName: repository.name,
        createdAt: repository.createdAt,
      });
    }
    for (const commit of Array.isArray(repository.commits) ? repository.commits : []) {
      const createdAt = commit.time || commit.createdAt;
      if (!createdAt) continue;
      activity.push({
        type: "commit",
        repositoryId,
        repositoryName: repository.name,
        message: commit.message || "Commit",
        createdAt,
      });
    }
  }
  return activity
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 15);
}

function repositorySummary(repository) {
  const visibleFileCount = (Array.isArray(repository.content) ? repository.content : []).filter((file) => {
    try { return !isSensitiveRepoPath(file.path || file.filename || ""); } catch { return true; }
  }).length;
  return {
    _id: getRepositoryId(repository),
    name: repository.name || "Untitled repository",
    description: repository.description || "",
    visibility: normalizeVisibility(repository.visibility),
    fileCount: visibleFileCount,
    commitCount: Array.isArray(repository.commits) ? repository.commits.length : 0,
    starCount: Number(repository.starCount)
      || (Array.isArray(repository.stars) ? repository.stars.length : 0),
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

function safeUser(user, { includeEmail = false } = {}) {
  const followers = Array.isArray(user.followers) ? user.followers : [];
  const following = Array.isArray(user.following)
    ? user.following
    : (Array.isArray(user.followedUsers) ? user.followedUsers : []);
  const result = {
    _id: user._id,
    name: user.name || "",
    username: user.username || "Developer",
    bio: user.bio || "",
    avatarUrl: safeStoredUrl(user.avatarUrl, "Avatar URL"),
    location: user.location || "",
    website: safeStoredUrl(user.website, "Website"),
    company: user.company || "",
    createdAt: user.createdAt || null,
    followersCount: followers.length,
    followingCount: following.length,
  };
  if (includeEmail) result.email = user.email || "";
  return result;
}

function buildProfileResponse(user, allRepositories, { isOwner = false, starredRepositories = [] } = {}) {
  const visibleRepositories = (Array.isArray(allRepositories) ? allRepositories : [])
    .filter((repository) => isOwner || normalizeVisibility(repository.visibility) === "public");
  const repositories = visibleRepositories.map(repositorySummary);
  const publicRepositories = repositories.filter((repository) => repository.visibility === "public").length;
  const commits = repositories.reduce((total, repository) => total + repository.commitCount, 0);
  const contributions = buildContributions(visibleRepositories);
  const popularRepositories = [...repositories]
    .sort((a, b) => b.starCount - a.starCount
      || b.commitCount - a.commitCount
      || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, 6);

  return {
    user: safeUser(user, { includeEmail: isOwner }),
    stats: {
      repositories: repositories.length,
      publicRepositories,
      ...(isOwner ? { privateRepositories: repositories.length - publicRepositories } : {}),
      commits,
      contributions: contributions.reduce((total, item) => total + item.count, 0),
    },
    repositories,
    popularRepositories,
    recentActivity: buildRecentActivity(visibleRepositories),
    contributions,
    starredRepositories: (Array.isArray(starredRepositories) ? starredRepositories : [])
      .filter((repository) => normalizeVisibility(repository.visibility) === "public")
      .map(repositorySummary),
  };
}

module.exports = {
  buildProfileResponse,
  normalizeVisibility,
  safeUser,
  validateProfileUpdate,
};
