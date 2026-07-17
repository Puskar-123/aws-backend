const normalizeUserId = (value) => String(value?.user?._id || value?.user?.id || value?.user || value?._id || value?.id || value || "").trim().toLowerCase();

const asPlain = (value) => value?.toObject ? value.toObject() : { ...value };

function normalizeRepositoryMembers(repository, repositoryMembers = [], legacyCollaborators = []) {
  const owner = repository?.owner; const ownerId = normalizeUserId(owner); const byUser = new Map();
  if (ownerId) byUser.set(ownerId, { user: owner, role: "owner", status: "active", isOwner: true });
  for (const source of repositoryMembers || []) {
    const item = asPlain(source); const userId = normalizeUserId(item);
    if (!userId || userId === ownerId || byUser.has(userId)) continue;
    byUser.set(userId, { ...item, user: item.user, status: item.status || "active", isOwner: false });
  }
  for (const source of legacyCollaborators || []) {
    const item = asPlain(source); const userId = normalizeUserId(item);
    if (!userId || userId === ownerId || byUser.has(userId)) continue;
    byUser.set(userId, { user: item.user, role: ({ read: "viewer", write: "temporary_contributor" }[item.role] || item.role), status: "active",
      invitedBy: item.addedBy, joinedAt: item.addedAt, migrationSource: `legacy_${item.role}`,
      legacyIndefiniteAccess: item.role === "write", allowedBranches: [], accessExpiresAt: null, isOwner: false });
  }
  return [...byUser.values()];
}

module.exports = { normalizeUserId, normalizeRepositoryMembers };
