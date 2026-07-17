const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const { s3, S3_BUCKET } = require("../config/aws-config");
const { isSensitiveRepoPath } = require("../utils/repoPath");
const { social: repositorySocial } = require("./repositorySocialController");
const { canViewRepository, permissionSummary, getRepositoryRole, hasRepositoryPermission, resolveRepositoryPermissionContext, getEffectiveMembershipStatus } = require("../services/repositoryPermissionService");
const { assertCanDirectWrite, getProtectionSummary } = require("../services/branchProtectionService");
const { getUserRepositoryStats } = require("../services/repositoryStatisticsService");
const RepositoryMember = require("../models/repositoryMemberModel");

function withoutAccessLists(document) {
  const value = document?.toObject ? document.toObject() : { ...document };
  delete value.collaborators;
  delete value.stars;
  delete value.watchers;
  delete value.forks;
  delete value.forkedBy;
  delete value.pendingCommits;
  return value;
}
async function visibleMembershipsForUser(userId) {
  if (!userId || mongoose.connection.readyState !== 1) return [];
  const memberships = await RepositoryMember.find({ user: userId, status: { $ne: "suspended" } }).lean();
  return memberships.filter((membership) => {
    const status = getEffectiveMembershipStatus(membership, null);
    return status === "active" || (status === "expired" && membership.retainViewerAfterExpiry);
  });
}

// ✅ CREATE REPOSITORY
async function createRepository(req, res) {

  const {
    name,
    issues,
    content,
    description,
    visibility,
    addReadme,
  } = req.body;

  console.log("REQ BODY:", req.body);

  try {

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Repository name is required!",
      });
    }

    const owner = req.user?.id;
    if (!owner || !mongoose.Types.ObjectId.isValid(owner)) {
      return res.status(400).json({
        error: "Invalid or missing User ID!",
      });
    }

    const existingRepo = await Repository.findOne({
      name: name.trim(),
      owner,
    });

    if (existingRepo) {
      return res.status(400).json({
        error: "Repository already exists!",
      });
    }

    const newRepository = new Repository({
      name: name.trim(),
      description: description || "",
      visibility: visibility || "public",
      owner,
      content: content || [],
      issues: issues || [],
      branches: [{ name: "main", head: null, isDefault: true }],
    });

    await newRepository.save();

  // ==========================
// CREATE README.md
// ==========================

if (addReadme) {

  const readmeKey = `${newRepository._id}/README.md`;

  const readmeContent = `# ${name}

${description || "No description."}

---

Created using CodeHub 🚀
`;

  try {

    console.log("🚀 Uploading README to S3...");
    console.log("Bucket:", S3_BUCKET);
    console.log("Key:", readmeKey);

    const result = await s3.upload({
      Bucket: S3_BUCKET,
      Key: readmeKey,
      Body: readmeContent,
      ContentType: "text/markdown",
    }).promise();

    console.log("✅ README uploaded successfully!");
    console.log(result);

  } catch (err) {

    console.error("❌ S3 Upload Error:");
    console.error(err);

    return res.status(500).json({
      error: err.message,
    });

  }

  newRepository.content.push({
    filename: "README.md",
    path: readmeKey,
  });

  await newRepository.save();
}
  // ✅ GET ALL
    return res.status(201).json({
      message: "Repository created!",
      repository: newRepository,
    });

  } catch (err) {
    console.error("FULL ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function getAllRepositories(req, res) {
    try {
      const userId = req.user?.id;
      const visibleMemberships = await visibleMembershipsForUser(userId);
      const memberRepositoryIds = visibleMemberships.map((membership) => membership.repository);
      const filter = userId
        ? { $or: [{ visibility: { $ne: "private" } }, { owner: userId }, { "collaborators.user": userId }, ...(memberRepositoryIds.length ? [{ _id: { $in: memberRepositoryIds } }] : [])] }
        : { visibility: { $ne: "private" } };
      const repositories = await Repository.find(filter)
        .populate("owner", "_id username name avatarUrl")
        .populate("issues");

      res.json(repositories.map(withoutAccessLists));

    } catch (err) {
      console.error("FULL ERROR:", err);
      res.status(500).json({ error: err.message });
    }
  }


// ✅ GET BY ID
async function fetchRepositoryById(req, res) {
  const { id } = req.params;

  try {
    // ✅ FIX: validate id
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID!" });
    }

    const repository = await Repository.findById(id)
      .populate("owner", "_id username")
      .populate({ path: "forkedFrom", select: "name owner", populate: { path: "owner", select: "username" } })
      .populate("issues");

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    const response = repository.toObject();
    const protectedFiles = response.content.filter((file) => {
      try { return isSensitiveRepoPath(file.path || file.filename); } catch { return false; }
    });
    response.content = response.content.filter((file) => !protectedFiles.includes(file));
    response.social = await repositorySocial(repository, req.user?.id || null);
    Object.assign(response, permissionSummary(repository, req.user?.id || null, req.repositoryMembership));
    const selectedBranch = req.query?.branch || repository.defaultBranch || "main";
    response.branchProtection = getProtectionSummary(repository, selectedBranch, req.user?.id || null);
    response.currentBranch = selectedBranch;
    const directWriteBlocked = response.branchProtection.protected
      && (response.branchProtection.blockDirectCommits || response.branchProtection.requirePullRequest)
      && !response.branchProtection.canBypass;
    response.permissions.canCommitDirectly = response.permissions.canEditFiles && !directWriteBlocked;
    response.permissions.canWriteUnprotectedBranches = response.permissions.canEditFiles;
    if (directWriteBlocked) {
      response.permissions.canEditFiles = false;
      response.permissions.canUploadFiles = false;
      response.permissions.canDeleteFiles = false;
      response.permissions.canRenameFiles = false;
    }
    delete response.stars;
    delete response.watchers;
    delete response.forks;
    delete response.forkedBy;
    delete response.collaborators;
    delete response.branchProtections;
    delete response.pendingCommits;
    if (protectedFiles.length) {
      response.warnings = [
        `${protectedFiles.length} protected file(s) are hidden. Previously uploaded secrets must be removed manually.`,
      ];
    }
    res.json(response);

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ GET BY NAME
async function fetchRepositoryByName(req, res) {
  const { name } = req.params;

  try {
    const repository = await Repository.findOne({ name })
      .populate("owner", "_id username avatarUrl")
      .populate("issues");

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    const context = await resolveRepositoryPermissionContext(repository, req.user?.id || null);
    if (!canViewRepository(repository, req.user?.id || null, { membership: context.membership })) {
      return res.status(req.user?.id ? 403 : 401).json({ error: req.user?.id ? "You do not have access to this repository" : "Authentication required" });
    }

    res.json(withoutAccessLists(repository));

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ USER REPOS
async function fetchRepositoriesForCurrentUser(req, res) {
  const { userID } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(userID)) {
      return res.status(400).json({ error: "Invalid User ID!" });
    }
    if (String(req.user?.id || "") !== String(userID)) {
      return res.status(403).json({ error: "You may only access your own repository dashboard" });
    }

    const fields = "_id name description visibility language owner collaborators updatedAt createdAt";
    const visibleMemberships = await visibleMembershipsForUser(userID);
    const memberRepositoryIds = visibleMemberships.map((membership) => membership.repository);
    const [owned, shared, statistics, memberships] = await Promise.all([
      Repository.find({ owner: userID }).select(fields).populate("owner", "_id username name avatarUrl").lean(),
      Repository.find({ $or: [{ "collaborators.user": userID }, ...(memberRepositoryIds.length ? [{ _id: { $in: memberRepositoryIds } }] : [])] }).select(fields).populate("owner", "_id username name avatarUrl").lean(),
      getUserRepositoryStats(userID),
      visibleMemberships,
    ]);
    const membershipsByRepository = new Map(memberships.map((member) => [String(member.repository), member]));
    const myRepositories = owned.map(({ collaborators, ...repository }) => repository);
    const sharedRepositories = shared
      .filter((repository) => String(repository.owner?._id || repository.owner) !== String(userID))
      .map((repository) => {
        const currentUserRole = getRepositoryRole(repository, userID, membershipsByRepository.get(String(repository._id)));
        const { collaborators, ...safe } = repository;
        return { ...safe, currentUserRole };
      });

    res.json({ repositories: myRepositories, myRepositories, sharedRepositories, statistics });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ UPDATE
async function updateRepositoryById(req, res) {
  const { id } = req.params;
  const { content, description } = req.body;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID!" });
    }

    const repository = req.repository || await Repository.findById(id);

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    if (content) {
      assertCanDirectWrite(
        repository,
        repository.defaultBranch || "main",
        req.user?.id,
        "repository_content_update"
      );
      repository.content.push(content);
    }
    if (description) {
      if (!hasRepositoryPermission(repository, req.user?.id, "manage_settings")) {
        return res.status(403).json({ error: "You do not have permission to change repository settings" });
      }
      repository.description = description;
    }

    const updatedRepository = await repository.save();

    res.json({
      message: "Repository updated!",
      repository: withoutAccessLists(updatedRepository),
    });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(err.status || 500).json({
      error: err.message,
      ...(err.code ? { code: err.code, branch: err.branch, suggestedAction: err.suggestedAction } : {}),
    });
  }
}


// ✅ TOGGLE VISIBILITY
async function toggleVisibilityById(req, res) {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID!" });
    }

    const repository = req.repository || await Repository.findById(id);

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    repository.visibility =
      repository.visibility === "public" ? "private" : "public";

    const updatedRepository = await repository.save();

    res.json({
      message: "Visibility updated!",
      repository: withoutAccessLists(updatedRepository),
    });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ DELETE
async function deleteRepositoryById(req, res) {
  try {
    const repository = req.repository;
    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    const ownerId = String(repository.owner?._id || repository.owner || "");
    if (repository.visibility === "private" && String(req.user?.id || "") !== ownerId) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    await repository.deleteOne();
    res.json({ message: "Repository deleted!" });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


module.exports = {
  createRepository,
  getAllRepositories,
  fetchRepositoryById,
  fetchRepositoryByName,
  fetchRepositoriesForCurrentUser,
  updateRepositoryById,
  toggleVisibilityById,
  deleteRepositoryById,
};
