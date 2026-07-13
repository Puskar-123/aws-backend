const { s3, S3_BUCKET } = require("../config/aws-config");
const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { buildCommitDiff, createS3ObjectReader } = require("../services/diffService");
const {
  findCommitDescriptor,
  getParentCommitDescriptor,
  reconstructSnapshot,
} = require("../services/snapshotService");

const COMMIT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function normalizedCommitMetadata(repository, descriptor, parentDescriptor) {
  const commit = descriptor.commit;
  const author = commit.author || {};
  const hash = String(commit.hash || commit._id || descriptor.id);
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: commit.message || "No message",
    author: {
      name: author.name || repository.owner?.username || "Unknown",
      email: author.email || repository.owner?.email || "",
    },
    time: commit.time || null,
    parent: commit.parent || commit.parents?.[0] || parentDescriptor?.id || null,
    parents: commit.parents?.length
      ? commit.parents
      : (commit.parent ? [commit.parent] : (parentDescriptor ? [parentDescriptor.id] : [])),
    branch: commit.branch || null,
  };
}

async function getCommitDiff(req, res) {
  const commitId = String(req.params.commitId || "");
  if (!COMMIT_ID_PATTERN.test(commitId)) {
    return res.status(400).json({ error: "Invalid commit identifier" });
  }

  try {
    const repository = await getAccessibleRepository(req, req.params.id, { populateOwner: true });
    const descriptor = findCommitDescriptor(repository, commitId);
    if (!descriptor) return res.status(404).json({ error: "Commit not found" });

    const parent = getParentCommitDescriptor(repository, descriptor);
    const snapshotCache = new Map();
    const warnings = [];
    if (parent.missingParent) warnings.push(`Parent commit ${parent.missingParent} is unavailable`);
    const previousSnapshot = reconstructSnapshot(repository, parent.descriptor, {
      cache: snapshotCache,
      warnings,
    });
    const currentSnapshot = reconstructSnapshot(repository, descriptor, {
      cache: snapshotCache,
      warnings,
    });
    const readObject = createS3ObjectReader(s3, S3_BUCKET, new Map());
    const diff = await buildCommitDiff(previousSnapshot, currentSnapshot, { readObject });

    return res.json({
      commit: normalizedCommitMetadata(repository, descriptor, parent.descriptor),
      summary: diff.summary,
      files: diff.files,
      warnings: [...new Set(warnings)],
    });
  } catch (error) {
    if (!error.status) {
      console.error(`Commit diff failed for repository ${req.params.id}, commit ${commitId}:`, error.message);
    }
    return sendAccessError(res, error);
  }
}

module.exports = { COMMIT_ID_PATTERN, getCommitDiff, normalizedCommitMetadata };
