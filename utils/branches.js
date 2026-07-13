function validateBranchName(name) {
  if (typeof name !== "string"
    || name.length < 1
    || name.length > 100
    || name === "HEAD"
    || name.startsWith("-")
    || name.startsWith("/")
    || name.endsWith("/")
    || name.endsWith(".")
    || name.endsWith(".lock")
    || name.includes("..")
    || name.includes("@{")
    || /[\s~^:?*\\\[\]]/.test(name)
    || name.split("/").some((part) => !part || part.startsWith("."))) {
    const error = new Error(`Invalid branch name: ${name}`);
    error.status = 400;
    throw error;
  }
  return name;
}

function ensureDefaultBranch(repository) {
  if (!repository.branches?.length) {
    repository.branches = [{ name: "main", head: null, isDefault: true }];
  }
  let defaultBranch = repository.branches.find((branch) => branch.isDefault);
  if (!defaultBranch) {
    defaultBranch = repository.branches[0];
    defaultBranch.isDefault = true;
  }
  return defaultBranch;
}

module.exports = { validateBranchName, ensureDefaultBranch };
