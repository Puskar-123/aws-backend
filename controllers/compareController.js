const { s3, S3_BUCKET } = require("../config/aws-config");
const { compareRepository } = require("../services/compareService");
const { getAccessibleRepository, sendAccessError } = require("../utils/repositoryAccess");
const { validateBranchName } = require("../utils/branches");

function createCompareController({
  getRepository = getAccessibleRepository,
  compare = compareRepository,
  storage = s3,
  bucket = S3_BUCKET,
} = {}) {
  async function compareBranches(req, res) {
    if (!req.query?.base) return res.status(400).json({ error: "Base branch is required" });
    if (!req.query?.compare) return res.status(400).json({ error: "Compare branch is required" });
    try {
      const base = validateBranchName(req.query.base);
      const compareName = validateBranchName(req.query.compare);
      if (base === compareName) {
        return res.status(400).json({ error: "Base and compare branches must be different" });
      }
      const repository = await getRepository(req, req.params.id, { populateOwner: true });
      const result = await compare(repository, base, compareName, { s3: storage, bucket });
      return res.json(result);
    } catch (error) {
      if (!error.status) console.error(`Branch comparison failed for repository ${req.params.id}:`, error.message);
      return sendAccessError(res, error);
    }
  }
  return { compareBranches };
}

module.exports = { createCompareController, ...createCompareController() };
