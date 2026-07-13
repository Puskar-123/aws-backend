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
        },
      ],

      time: {
        type: Date,
      },
    },
  ],

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

module.exports = mongoose.model("Repository", RepositorySchema);
