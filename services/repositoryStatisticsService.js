const mongoose = require("mongoose");
const Repository = require("../models/repoModel");

function buildOwnedRepositoryStatisticsPipeline(userId) {
  const owner = userId instanceof mongoose.Types.ObjectId
    ? userId
    : new mongoose.Types.ObjectId(String(userId));

  return [
    { $match: { owner } },
    {
      $project: {
        visibility: 1,
        commitKeys: {
          $map: {
            input: {
              $range: [
                0,
                { $size: { $cond: [{ $isArray: "$commits" }, "$commits", []] } },
              ],
            },
            as: "commitIndex",
            in: {
              $let: {
                vars: {
                  commit: { $arrayElemAt: ["$commits", "$$commitIndex"] },
                },
                in: {
                  $concat: [
                    { $toString: "$_id" },
                    ":",
                    {
                      $ifNull: [
                        {
                          $convert: {
                            input: { $ifNull: ["$$commit.hash", { $ifNull: ["$$commit._id", "$$commit"] }] },
                            to: "string",
                            onError: null,
                            onNull: null,
                          },
                        },
                        { $concat: ["legacy-index-", { $toString: "$$commitIndex" }] },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    {
      $project: {
        visibility: 1,
        commitKeys: { $setDifference: [{ $setUnion: ["$commitKeys", []] }, [null, ""]] },
      },
    },
    {
      $group: {
        _id: null,
        repositories: { $sum: 1 },
        publicRepositories: { $sum: { $cond: [{ $eq: ["$visibility", "private"] }, 0, 1] } },
        privateRepositories: { $sum: { $cond: [{ $eq: ["$visibility", "private"] }, 1, 0] } },
        commitKeySets: { $push: "$commitKeys" },
      },
    },
    {
      $project: {
        _id: 0,
        repositories: 1,
        publicRepositories: 1,
        privateRepositories: 1,
        commits: {
          $size: {
            $reduce: {
              input: "$commitKeySets",
              initialValue: [],
              in: { $setUnion: ["$$value", "$$this"] },
            },
          },
        },
      },
    },
  ];
}

async function getUserRepositoryStats(userId, { RepositoryModel = Repository } = {}) {
  if (!mongoose.Types.ObjectId.isValid(userId)) throw Object.assign(new Error("Invalid User ID!"), { status: 400 });
  const [statistics] = await RepositoryModel.aggregate(buildOwnedRepositoryStatisticsPipeline(userId));
  return statistics || { repositories: 0, publicRepositories: 0, privateRepositories: 0, commits: 0 };
}

const countOwnedRepositoryCommits = async (userId, options) => (await getUserRepositoryStats(userId, options)).commits;

module.exports = { buildOwnedRepositoryStatisticsPipeline, getUserRepositoryStats, countOwnedRepositoryCommits };
