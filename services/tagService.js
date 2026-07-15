const { findCommitDescriptor, getCommitDescriptors } = require("./snapshotService");

function inputError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function validateTagName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 100) throw inputError(400, "Tag name must be between 1 and 100 characters", "INVALID_TAG_NAME");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    || name.endsWith("/") || name.includes("//") || name.includes("..") || name.includes("@{")
    || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw inputError(400, "Tag name contains unsupported or unsafe characters", "INVALID_TAG_NAME");
  }
  return name;
}

function normalizeTagName(value) { return validateTagName(value).toLocaleLowerCase("en-US"); }

function resolveTagTarget(repository, value) {
  const target = String(value || "").trim();
  if (!target) throw inputError(400, "A branch or commit target is required", "INVALID_TAG_TARGET");
  const branch = (repository.branches || []).find((item) => item.name === target);
  const requested = branch ? String(branch.head || "") : target;
  if (branch && !requested) throw inputError(400, `Branch '${target}' has no commits`, "EMPTY_TAG_TARGET");
  let descriptor = findCommitDescriptor(repository, requested);
  if (!descriptor) {
    const prefixes = getCommitDescriptors(repository).filter(({ id, commit }) =>
      id.startsWith(requested) || String(commit.hash || "").startsWith(requested));
    if (prefixes.length > 1) throw inputError(409, "Commit target is ambiguous; use a longer hash", "AMBIGUOUS_TAG_TARGET");
    descriptor = prefixes[0] || null;
  }
  if (!descriptor) throw inputError(404, "Target commit was not found in this repository", "TAG_TARGET_NOT_FOUND");
  return { descriptor, hash: String(descriptor.commit.hash || descriptor.id) };
}

function safeTag(tag, repository) {
  const value = tag?.toObject ? tag.toObject() : { ...tag };
  const descriptor = findCommitDescriptor(repository, value.targetCommitHash);
  return {
    _id: value._id, name: value.name, targetCommitHash: value.targetCommitHash,
    message: value.message || "", createdBy: value.createdBy, createdAt: value.createdAt,
    updatedAt: value.updatedAt, target: descriptor ? {
      hash: String(descriptor.commit.hash || descriptor.id), message: descriptor.commit.message || "",
      author: descriptor.commit.author || null, time: descriptor.commit.time || null,
    } : { hash: value.targetCommitHash, unavailable: true },
  };
}

module.exports = { inputError, normalizeTagName, resolveTagTarget, safeTag, validateTagName };
