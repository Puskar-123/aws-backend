const mongoose = require("mongoose");
const { Schema } = mongoose;

const RepositorySchema = new Schema(
{
  name: {
    type: String,
    required: true,
    unique: true,
  },

  description: {
    type: String,
  },

  language: {
    type: String,
    default: "",
    maxlength: 40,
  },

  // Latest files
  content: [
    {
      filename: {
        type: String,
        required: true,
      },
      path: {
        type: String,
        required: true,
      },
      s3Key: {
        type: String,
      },
      storageKey: {
        type: String,
      },
      hash: {
        type: String,
      },
      size: Number,
      contentType: String,
    },
  ],

  // Commit History
  commits: [
    {
      message: {
        type: String,
      },

      files: [
        {
          filename: String,
          path: String,
          s3Key: String,
          storageKey: String,
          hash: String,
          size: Number,
          contentType: String,
          status: String,
          oldPath: String,
        },
      ],

      snapshot: [
        {
          filename: String,
          path: String,
          s3Key: String,
          storageKey: String,
          hash: String,
          size: Number,
          contentType: String,
        },
      ],

      hash: String,
      parent: String,
      parents: [String],
      branch: String,
      storageId: String,
      author: {
        name: String,
        email: String,
      },
      deletedFiles: [String],
      summary: {
        filesChanged: Number,
        additions: Number,
        deletions: Number,
      },

      time: {
        type: Date,
      },
    },
  ],

  branches: [
    new Schema({
      name: {
        type: String,
        required: true,
      },
      head: {
        type: String,
        default: null,
      },
      isDefault: {
        type: Boolean,
        default: false,
      },
    }, { _id: false, timestamps: true }),
  ],

  defaultBranch: {
    type: String,
    default: "main",
  },

  branchProtections: [new Schema({
    branch: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    requirePullRequest: { type: Boolean, default: true },
    requiredApprovals: { type: Number, default: 1, min: 0, max: 10 },
    blockDirectCommits: { type: Boolean, default: true },
    blockForcePush: { type: Boolean, default: true },
    blockDeletion: { type: Boolean, default: true },
    requireResolvedConversations: { type: Boolean, default: false },
    dismissStaleApprovals: { type: Boolean, default: false },
    allowOwnerBypass: { type: Boolean, default: true },
    allowMaintainerBypass: { type: Boolean, default: false },
    requireStatusChecks: { type: Boolean, default: false },
    requiredStatusChecks: [{ type: String, trim: true, maxlength: 300 }],
    requireUpToDate: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  }, { timestamps: true })],

  pullRequestCounter: {
    type: Number,
    default: 0,
    min: 0,
  },

  issueCounter: {
    type: Number,
    default: 0,
    min: 0,
  },

  stars: [{ type: Schema.Types.ObjectId, ref: "User" }],
  watchers: [{ type: Schema.Types.ObjectId, ref: "User" }],
  forks: [{ type: Schema.Types.ObjectId, ref: "Repository" }],
  forkedFrom: { type: Schema.Types.ObjectId, ref: "Repository", default: null },
  forkedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  forkDepth: { type: Number, default: 0, min: 0 },

  visibility: {
    type: String,
    enum: ["public", "private"],
    default: "public",
  },

  owner: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  collaborators: [{
    _id: false,
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["maintainer", "write", "read"], required: true },
    addedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    addedAt: { type: Date, default: Date.now },
  }],

  issues: [
    {
      type: Schema.Types.ObjectId,
      ref: "Issue",
    },
  ],
},
{
  timestamps: true,
}
);

RepositorySchema.index({ owner: 1, forkedFrom: 1 }, {
  unique: true,
  partialFilterExpression: { forkedFrom: { $type: "objectId" } },
});
RepositorySchema.index({ stars: 1 });
RepositorySchema.index({ watchers: 1 });
RepositorySchema.index({ visibility: 1, updatedAt: -1 });
RepositorySchema.index({ visibility: 1, name: 1 });
RepositorySchema.index({ "collaborators.user": 1 });

module.exports = mongoose.model("Repository", RepositorySchema);
