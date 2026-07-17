require("dotenv").config();
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const RepositoryMember = require("../models/repositoryMemberModel");
const RepositoryRoleAudit = require("../models/repositoryRoleAuditModel");

const isDryRun = (argv = process.argv.slice(2)) => argv.includes("--dry-run");

async function normalizeOwnerMemberships({ dryRun = true, RepositoryModel = Repository, MemberModel = RepositoryMember, AuditModel = RepositoryRoleAudit, session = null } = {}) {
  const counts = { repositoriesScanned: 0, repositoriesChanged: 0, ownerMembershipsRemoved: 0, legacyOwnerEntriesRemoved: 0, auditsCreated: 0 };
  const repositories = await RepositoryModel.find({}).select("_id owner collaborators").lean().session?.(session) || [];
  for (const repository of repositories) {
    counts.repositoriesScanned += 1; const owner = String(repository.owner); if (!owner) continue;
    const ownerMemberships = await MemberModel.find({ repository: repository._id, user: repository.owner }).select("_id role status").lean().session?.(session) || [];
    const legacyCount = (repository.collaborators || []).filter((item) => String(item.user) === owner).length;
    if (!ownerMemberships.length && !legacyCount) continue;
    counts.repositoriesChanged += 1; counts.ownerMembershipsRemoved += ownerMemberships.length; counts.legacyOwnerEntriesRemoved += legacyCount;
    if (dryRun) continue;
    await AuditModel.create([{ repository: repository._id, targetUser: repository.owner, action: "owner_duplicate_normalized",
      performedBy: null, reason: "Removed redundant owner collaborator records", metadata: { ownerMemberships: ownerMemberships.length, legacyEntries: legacyCount } }], { session });
    counts.auditsCreated += 1;
    if (ownerMemberships.length) await MemberModel.deleteMany({ _id: { $in: ownerMemberships.map((item) => item._id) } }, { session });
    if (legacyCount) await RepositoryModel.updateOne({ _id: repository._id }, { $pull: { collaborators: { user: repository.owner } } }, { session });
  }
  return counts;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI or MONGODB_URI is required");
  await mongoose.connect(uri); const dryRun = isDryRun();
  try {
    let counts;
    if (dryRun) counts = await normalizeOwnerMemberships({ dryRun: true });
    else {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => { counts = await normalizeOwnerMemberships({ dryRun: false, session }); });
      } catch (error) {
        const unsupported = /Transaction numbers are only allowed|replica set|transactions are not supported/i.test(error.message);
        if (!unsupported) throw error;
        counts = await normalizeOwnerMemberships({ dryRun: false });
      } finally { await session.endSession(); }
    }
    console.log(JSON.stringify({ dryRun, ...counts }, null, 2));
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch((error) => { console.error(`Owner normalization failed: ${error.message}`); process.exitCode = 1; });
module.exports = { isDryRun, normalizeOwnerMemberships };
