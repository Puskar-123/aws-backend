const mongoose = require("mongoose");
const { Schema } = mongoose;

const UserSchema = new Schema(
{
  name: {
    type: String,
    trim: true,
    maxlength: 80,
    default: "",
  },
  username: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
  },
  bio: {
    type: String,
    maxlength: 160,
    default: "",
  },
  avatarUrl: {
    type: String,
    default: "",
  },
  location: {
    type: String,
    maxlength: 100,
    default: "",
  },
  website: {
    type: String,
    maxlength: 200,
    default: "",
  },
  company: {
    type: String,
    maxlength: 100,
    default: "",
  },
  repositories: [
    {
      default: [],
      type: Schema.Types.ObjectId,
      ref: "Repository",
    },
  ],
  followedUsers: [
    {
      default: [],
      type: Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  followers: [{
    type: Schema.Types.ObjectId,
    ref: "User",
  }],
  following: [{
    type: Schema.Types.ObjectId,
    ref: "User",
  }],
  starRepos: [
    {
      default: [],
      type: Schema.Types.ObjectId,
      ref: "Repository",
    },
  ],
  starredRepositories: [{
    type: Schema.Types.ObjectId,
    ref: "Repository",
  }],
},
{
  timestamps: true
}
);

const User = mongoose.model("User", UserSchema);

module.exports = User;


// const mongoose = require("mongoose");
// const { Schema } = mongoose;

// const UserSchema = new Schema({
//   timestamps: true,
//   username: {
//     type: String,
//     required: true,
//     unique: true,
//   },
//   email: {
//     type: String,
//     required: true,
//     unique: true,
//   },
//   password: {
//     type: String,
//   },
//   repositories: [
//     {
//       default: [],
//       type: Schema.Types.ObjectId,
//       ref: "Repository",
//     },
//   ],
//   followedUsers: [
//     {
//       default: [],
//       type: Schema.Types.ObjectId,
//       ref: "User",
//     },
//   ],
//   starRepos: [
//     {
//       default: [],
//       type: Schema.Types.ObjectId,
//       ref: "Repository",
//     },
//   ],
// });

// const User = mongoose.model("User", UserSchema);

// module.exports = User;
