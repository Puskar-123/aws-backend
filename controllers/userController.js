const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { MongoClient, ObjectId } = require("mongodb");
const dotenv = require("dotenv");

dotenv.config();
const uri = process.env.MONGODB_URI;

let client;

async function connectClient() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
}

function getCollection() {
  // Use the database selected by MONGODB_URI so Mongoose User references and
  // authentication records live in the same database.
  return client.db().collection("users");
}

function getLegacyCollection() {
  return client.db("githubclone").collection("users");
}

/* ================== AUTH ================== */

async function signup(req, res) {
  const { username, password, email } = req.body;

  try {
    await connectClient();
    const users = getCollection();

    const existing = await users.findOne({ username });
    if (existing) {
      return res.status(400).json({ message: "User already exists!" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = {
      name: "",
      username,
      password: hashedPassword,
      email,
      bio: "",
      avatarUrl: "",
      location: "",
      website: "",
      company: "",
      repositories: [],
      followers: [],      // ✅ NEW
      following: [],      // ✅ NEW
      starRepos: [],
      starredRepositories: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await users.insertOne(newUser);

    const token = jwt.sign(
      { id: result.insertedId },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "1h" }
    );

    res.json({ token, userId: result.insertedId });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
}

async function login(req, res) {
  const { email, password } = req.body;

  try {
    await connectClient();
    const users = getCollection();

    let user = await users.findOne({ email });
    let fromLegacyDatabase = false;
    if (!user && users.namespace !== getLegacyCollection().namespace) {
      user = await getLegacyCollection().findOne({ email });
      fromLegacyDatabase = Boolean(user);
    }
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // A verified legacy login is sufficient proof to copy the same User _id
    // into the primary database. PR documents are never rewritten here.
    if (fromLegacyDatabase) {
      await users.updateOne({ _id: user._id }, { $setOnInsert: user }, { upsert: true });
    }

    // ✅ FIXED
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "1h" }
    );

    res.json({ token, userId: user._id });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
}

/* ================== USERS ================== */

async function getAllUsers(req, res) {
  try {
    await connectClient();
    const users = getCollection();

    const data = await users.find({}).toArray();
    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
}

async function getUserProfile(req, res) {
  try {
    await connectClient();
    const users = getCollection();

    const user = await users.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json(user);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
}

/* ================== FOLLOW SYSTEM ================== */

// 🔥 FOLLOW / UNFOLLOW
async function followUser(req, res) {
  try {
    await connectClient();
    const users = getCollection();

    const { followerId, followingId } = req.body;
    if (String(req.user?.id || "") !== String(followerId || "")) {
      return res.status(403).json({ error: "You may only update your own follows" });
    }

    const follower = await users.findOne({ _id: new ObjectId(followerId) });
    const target = await users.findOne({ _id: new ObjectId(followingId) });

    const isFollowing = follower.following.includes(followingId);

    if (isFollowing) {
      // UNFOLLOW
      await users.updateOne(
        { _id: new ObjectId(followerId) },
        { $pull: { following: followingId } }
      );

      await users.updateOne(
        { _id: new ObjectId(followingId) },
        { $pull: { followers: followerId } }
      );

    } else {
      // FOLLOW
      await users.updateOne(
        { _id: new ObjectId(followerId) },
        { $push: { following: followingId } }
      );

      await users.updateOne(
        { _id: new ObjectId(followingId) },
        { $push: { followers: followerId } }
      );
    }

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Follow failed" });
  }
}

// 🔥 CHECK FOLLOW
async function isFollowing(req, res) {
  try {
    await connectClient();
    const users = getCollection();

    const { followerId, followingId } = req.params;

    const user = await users.findOne({
      _id: new ObjectId(followerId),
    });

    const result = user.following.includes(followingId);

    res.json({ isFollowing: result });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Check failed" });
  }
}

/* ================== UPDATE / DELETE ================== */

async function updateUserProfile(req, res) {
  try {
    if (String(req.user?.id || "") !== String(req.params.id || "")) {
      return res.status(403).json({ error: "You may only update your own profile" });
    }
    await connectClient();
    const users = getCollection();

    const { email, password } = req.body;

    let updateFields = { email };

    if (password) {
      updateFields.password = await bcrypt.hash(password, 10);
    }

    const result = await users.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    res.json(result.value);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
}

async function deleteUserProfile(req, res) {
  try {
    if (String(req.user?.id || "") !== String(req.params.id || "")) {
      return res.status(403).json({ error: "You may only delete your own profile" });
    }
    await connectClient();
    const users = getCollection();

    const result = await users.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "User deleted" });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
}

/* ================== EXPORT ================== */

module.exports = {
  connectClient,
  getCollection,
  getLegacyCollection,
  signup,
  login,
  getAllUsers,
  getUserProfile,
  updateUserProfile,
  deleteUserProfile,
  followUser,
  isFollowing,
};



// const jwt = require("jsonwebtoken");
// const bcrypt = require("bcryptjs");
// const { MongoClient } = require("mongodb");
// const dotenv = require("dotenv");
// var ObjectId = require("mongodb").ObjectId;

// dotenv.config();
// const uri = process.env.MONGODB_URI;

// let client;

// async function connectClient() {
//   if (!client) {
//     client = new MongoClient(uri, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//     });
//     await client.connect();
//   }
// }

// async function signup(req, res) {
//   const { username, password, email } = req.body;
//   try {
//     await connectClient();
//     const db = client.db("githubclone");
//     const usersCollection = db.collection("users");

//     const user = await usersCollection.findOne({ username });
//     if (user) {
//       return res.status(400).json({ message: "User already exists!" });
//     }

//     const salt = await bcrypt.genSalt(10);
//     const hashedPassword = await bcrypt.hash(password, salt);

//     const newUser = {
//       username,
//       password: hashedPassword,
//       email,
//       repositories: [],
//       followedUsers: [],
//       starRepos: [],
//     };

//     const result = await usersCollection.insertOne(newUser);

//     const token = jwt.sign(
//       { id: result.insertId },
//       process.env.JWT_SECRET_KEY,
//       { expiresIn: "1h" }
//     );
//     res.json({ token, userId: result.insertId });
//   } catch (err) {
//     console.error("Error during signup : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function login(req, res) {
//   const { email, password } = req.body;
//   try {
//     await connectClient();
//     const db = client.db("githubclone");
//     const usersCollection = db.collection("users");

//     const user = await usersCollection.findOne({ email });
//     if (!user) {
//       return res.status(400).json({ message: "Invalid credentials!" });
//     }

//     const isMatch = await bcrypt.compare(password, user.password);
//     if (!isMatch) {
//       return res.status(400).json({ message: "Invalid credentials!" });
//     }

//     const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET_KEY, {
//       expiresIn: "1h",
//     });
//     res.json({ token, userId: user._id });
//   } catch (err) {
//     console.error("Error during login : ", err.message);
//     res.status(500).send("Server error!");
//   }
// }

// async function getAllUsers(req, res) {
//   try {
//     await connectClient();
//     const db = client.db("githubclone");
//     const usersCollection = db.collection("users");

//     const users = await usersCollection.find({}).toArray();
//     res.json(users);
//   } catch (err) {
//     console.error("Error during fetching : ", err.message);
//     res.status(500).send("Server error!");
//   }
// }

// async function getUserProfile(req, res) {
//   const currentID = req.params.id;

//   try {
//     await connectClient();
//     const db = client.db("githubclone");
//     const usersCollection = db.collection("users");

//     const user = await usersCollection.findOne({
//       _id: new ObjectId(currentID),
//     });

//     if (!user) {
//       return res.status(404).json({ message: "User not found!" });
//     }

//     res.send(user);
//   } catch (err) {
//     console.error("Error during fetching : ", err.message);
//     res.status(500).send("Server error!");
//   }
// }

// async function updateUserProfile(req, res) {
//   const currentID = req.params.id;
//   const { email, password } = req.body;

//   try {
//     await connectClient();
//     const db = client.db("githubclone");
//     const usersCollection = db.collection("users");

//     let updateFields = { email };
//     if (password) {
//       const salt = await bcrypt.genSalt(10);
//       const hashedPassword = await bcrypt.hash(password, salt);
//       updateFields.password = hashedPassword;
//     }

//     const result = await usersCollection.findOneAndUpdate(
//       {
//         _id: new ObjectId(currentID),
//       },
//       { $set: updateFields },
//       { returnDocument: "after" }
//     );
//     if (!result.value) {
//       return res.status(404).json({ message: "User not found!" });
//     }

//     res.send(result.value);
//   } catch (err) {
//     console.error("Error during updating : ", err.message);
//     res.status(500).send("Server error!");
//   }
// }

// async function deleteUserProfile(req, res) {
//   const currentID = req.params.id;

//   try {
//     await connectClient();
//     const db = client.db("githubclone");
//     const usersCollection = db.collection("users");

//     const result = await usersCollection.deleteOne({
//       _id: new ObjectId(currentID),
//     });

//     if (result.deleteCount == 0) {
//       return res.status(404).json({ message: "User not found!" });
//     }

//     res.json({ message: "User Profile Deleted!" });
//   } catch (err) {
//     console.error("Error during updating : ", err.message);
//     res.status(500).send("Server error!");
//   }
// }

// module.exports = {
//   getAllUsers,
//   signup,
//   login,
//   getUserProfile,
//   updateUserProfile,
//   deleteUserProfile,
// };
