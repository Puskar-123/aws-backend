const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const RepositoryMember = require("../models/repositoryMemberModel");
const RepositoryRoleAudit = require("../models/repositoryRoleAuditModel");
dotenv.config();

const VERSION = 1;
const blankSummary = () => ({ repositoriesScanned: 0, ownersNormalized: 0, maintainersMigrated: 0,
  writeCollaboratorsMigrated: 0, readCollaboratorsMigrated: 0, duplicatesSkipped: 0,
  invalidRecordsSkipped: 0, errors: 0 });
const idOf = (value) => String(value?._id || value || "");

function migrationDocument(repository, user, role, source, collaborator = {}) {
  return { repository: repository._id, user, role, status: "active", permissions: undefined,
    allowedBranches: [], accessStartsAt: null, accessExpiresAt: null, retainViewerAfterExpiry: false,
    invitedBy: collaborator.addedBy || null, joinedAt: collaborator.addedAt || repository.createdAt || new Date(),
    migrationSource: source, legacyIndefiniteAccess: source === "legacy_write" };
}

async function migrateRepository(repository, { dryRun, MemberModel, AuditModel, RepositoryModel }, summary) {
  if (!repository.owner || !mongoose.Types.ObjectId.isValid(repository.owner)) { summary.invalidRecordsSkipped += 1; return; }
  const candidates = [{ user: repository.owner, role: "owner", source: "legacy_owner", counter: "ownersNormalized" }];
  for (const collaborator of repository.collaborators || []) {
    if (!collaborator?.user || !mongoose.Types.ObjectId.isValid(collaborator.user) || idOf(collaborator.user) === idOf(repository.owner)) { summary.invalidRecordsSkipped += 1; continue; }
    const mapping = { maintainer: ["maintainer", "legacy_maintainer", "maintainersMigrated"],
      write: ["temporary_contributor", "legacy_write", "writeCollaboratorsMigrated"],
      read: ["viewer", "legacy_read", "readCollaboratorsMigrated"] }[collaborator.role];
    if (!mapping) { summary.invalidRecordsSkipped += 1; continue; }
    candidates.push({ user: collaborator.user, role: mapping[0], source: mapping[1], counter: mapping[2], collaborator });
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const key = idOf(candidate.user); if (seen.has(key)) { summary.duplicatesSkipped += 1; continue; } seen.add(key);
    const query = { repository: repository._id, user: candidate.user };
    const exists = MemberModel.findOne ? await MemberModel.findOne(query) : await MemberModel.exists(query);
    if (exists) {
      if (candidate.source === "legacy_owner" && (exists.role !== "owner" || exists.status !== "active" || exists.migrationSource !== "legacy_owner")) {
        summary.ownersNormalized += 1;
        if (!dryRun) await MemberModel.updateOne(query, { $set: { role: "owner", status: "active", migrationSource: "legacy_owner", legacyIndefiniteAccess: false,
          allowedBranches: [], accessStartsAt: null, accessExpiresAt: null, retainViewerAfterExpiry: false } });
      } else summary.duplicatesSkipped += 1;
      continue;
    }
    summary[candidate.counter] += 1;
    if (dryRun) continue;
    const document = migrationDocument(repository, candidate.user, candidate.role, candidate.source, candidate.collaborator);
    await MemberModel.create(document);
    await AuditModel.updateOne({ repository: repository._id, targetUser: candidate.user, action: "legacy_member_migrated" },
      { $setOnInsert: { repository: repository._id, targetUser: candidate.user, action: "legacy_member_migrated",
        newRole: candidate.role, newStatus: "active", newAllowedBranches: [], metadata: { migrationVersion: VERSION }, createdAt: new Date() } }, { upsert: true });
  }
  if (!dryRun) await RepositoryModel.updateOne({ _id: repository._id }, { $set: { repositoryRolesMigrationVersion: VERSION } });
}

async function runMigration({ dryRun = process.argv.includes("--dry-run"), RepositoryModel = Repository,
  MemberModel = RepositoryMember, AuditModel = RepositoryRoleAudit } = {}) {
  const summary = blankSummary();
  const cursor = RepositoryModel.find({}).select("_id owner collaborators createdAt repositoryRolesMigrationVersion").cursor();
  for await (const repository of cursor) {
    summary.repositoriesScanned += 1;
    try { await migrateRepository(repository, { dryRun, RepositoryModel, MemberModel, AuditModel }, summary); }
    catch { summary.errors += 1; }
  }
  return summary;
}

function logSummary(summary, dryRun) {
  console.log(dryRun ? "Repository roles migration dry run" : "Repository roles migration complete");
  for (const [name, count] of Object.entries(summary)) console.log(`${name}: ${count}`);
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  await mongoose.connect(process.env.MONGODB_URI);
  try { const dryRun = process.argv.includes("--dry-run"); const summary = await runMigration({ dryRun }); logSummary(summary, dryRun); if (summary.errors) process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch((error) => { console.error(`Repository roles migration failed: ${error.message}`); process.exitCode = 1; });
module.exports = { VERSION, blankSummary, migrationDocument, migrateRepository, runMigration };
