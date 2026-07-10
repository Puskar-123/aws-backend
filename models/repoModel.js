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
  content: [
  {
    filename: {
      type: String,
      required: true,
    },
    path: {
      type: String,
      required: true,
    }
  }
  ],
  visibility: {
    type: String,
    enum: ["public", "private"],
    default: "public"
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
  timestamps: true
}
);

const Repository = mongoose.model("Repository", RepositorySchema);
module.exports = Repository;


