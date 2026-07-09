const mongoose = require("mongoose");
const Repository = require("../models/repoModel");


// ✅ CREATE REPOSITORY
async function createRepository(req, res) {
  const { owner, name, issues, content, description, visibility } = req.body;

  console.log("REQ BODY:", req.body); // ✅ DEBUG

  try {
    if (!name) {
      return res.status(400).json({ error: "Repository name is required!" });
    }

    if (!owner || !mongoose.Types.ObjectId.isValid(owner)) {
      return res.status(400).json({ error: "Invalid or missing User ID!" });
    }

    // ✅ duplicate check (same user)
    const existingRepo = await Repository.findOne({ name, owner });

    if (existingRepo) {
      return res.status(400).json({
        error: "Repository already exists!",
      });
    }

    const newRepository = new Repository({
      name,
      description: description || "",
      visibility: visibility || "public",
      owner,
      content: content || [],
      issues: issues || [],
    });

    const result = await newRepository.save();

    res.status(201).json({
      message: "Repository created!",
      repositoryID: result._id,
    });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ GET ALL
async function getAllRepositories(req, res) {
  try {
    const repositories = await Repository.find({})
      .populate("owner")
      .populate("issues");

    res.json(repositories);

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ GET BY ID
async function fetchRepositoryById(req, res) {
  const { id } = req.params;

  try {
    // ✅ FIX: validate id
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID!" });
    }

    const repository = await Repository.findById(id)
      .populate("owner")
      .populate("issues");

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    res.json(repository);

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ GET BY NAME
async function fetchRepositoryByName(req, res) {
  const { name } = req.params;

  try {
    const repository = await Repository.findOne({ name })
      .populate("owner")
      .populate("issues");

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    res.json(repository);

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ USER REPOS
async function fetchRepositoriesForCurrentUser(req, res) {
  const { userID } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(userID)) {
      return res.status(400).json({ error: "Invalid User ID!" });
    }

    const repositories = await Repository.find({ owner: userID });

    if (!repositories.length) {
      return res.status(404).json({ error: "No repositories found!" });
    }

    res.json({ repositories });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ UPDATE
async function updateRepositoryById(req, res) {
  const { id } = req.params;
  const { content, description } = req.body;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID!" });
    }

    const repository = await Repository.findById(id);

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    if (content) repository.content.push(content);
    if (description) repository.description = description;

    const updatedRepository = await repository.save();

    res.json({
      message: "Repository updated!",
      repository: updatedRepository,
    });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ TOGGLE VISIBILITY
async function toggleVisibilityById(req, res) {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID!" });
    }

    const repository = await Repository.findById(id);

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    repository.visibility =
      repository.visibility === "public" ? "private" : "public";

    const updatedRepository = await repository.save();

    res.json({
      message: "Visibility updated!",
      repository: updatedRepository,
    });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


// ✅ DELETE
async function deleteRepositoryById(req, res) {
  const { id } = req.params;

  try {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid repository ID!" });
    }

    const repository = await Repository.findByIdAndDelete(id);

    if (!repository) {
      return res.status(404).json({ error: "Repository not found!" });
    }

    res.json({ message: "Repository deleted!" });

  } catch (err) {
    console.error("FULL ERROR:", err);
    res.status(500).json({ error: err.message });
  }
}


module.exports = {
  createRepository,
  getAllRepositories,
  fetchRepositoryById,
  fetchRepositoryByName,
  fetchRepositoriesForCurrentUser,
  updateRepositoryById,
  toggleVisibilityById,
  deleteRepositoryById,
};


// const mongoose = require("mongoose");
// const Repository = require("../models/repoModel");
// const User = require("../models/userModel");
// const Issue = require("../models/issueModel");

// async function createRepository(req, res) {
//   const { owner, name, issues, content, description, visibility } = rq.body;

//   try {
//     if (!name) {
//       return res.status(400).json({ error: "Repository name is required!" });
//     }

//     if (!mongoose.Types.ObjectId.isValid(owner)) {
//       return res.status(400).json({ error: "Invalid User ID!" });
//     }

//     const newRepository = new Repository({
//       name,
//       description,
//       visibility,
//       owner,
//       content,
//       issues,
//     });

//     const result = await newRepository.save();

//     res.status(201).json({
//       message: "Repository created!",
//       repositoryID: result._id,
//     });
//   } catch (err) {
//     console.error("Error during repository creation : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function getAllRepositories(req, res) {
//   try {
//     const repositories = await Repository.find({})
//       .populate("owner")
//       .populate("issues");

//     res.json(repositories);
//   } catch (err) {
//     console.error("Error during fetching repositories : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function fetchRepositoryById(req, res) {
//   const { id } = req.params;
//   try {
//     const repository = await Repository.find({ _id: id })
//       .populate("owner")
//       .populate("issues");

//     res.json(repository);
//   } catch (err) {
//     console.error("Error during fetching repository : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function fetchRepositoryByName(req, res) {
//   const { name } = req.params;
//   try {
//     const repository = await Repository.find({ name })
//       .populate("owner")
//       .populate("issues");

//     res.json(repository);
//   } catch (err) {
//     console.error("Error during fetching repository : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function fetchRepositoriesForCurrentUser(req, res) {
//   console.log(req.params);
//   const { userID } = req.params;

//   try {
//     const repositories = await Repository.find({ owner: userID });

//     if (!repositories || repositories.length == 0) {
//       return res.status(404).json({ error: "User Repositories not found!" });
//     }
//     console.log(repositories);
//     res.json({ message: "Repositories found!", repositories });
//   } catch (err) {
//     console.error("Error during fetching user repositories : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function updateRepositoryById(req, res) {
//   const { id } = req.params;
//   const { content, description } = req.body;

//   try {
//     const repository = await Repository.findById(id);
//     if (!repository) {
//       return res.status(404).json({ error: "Repository not found!" });
//     }

//     repository.content.push(content);
//     repository.description = description;

//     const updatedRepository = await repository.save();

//     res.json({
//       message: "Repository updated successfully!",
//       repository: updatedRepository,
//     });
//   } catch (err) {
//     console.error("Error during updating repository : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function toggleVisibilityById(req, res) {
//   const { id } = req.params;

//   try {
//     const repository = await Repository.findById(id);
//     if (!repository) {
//       return res.status(404).json({ error: "Repository not found!" });
//     }

//     repository.visibility = !repository.visibility;

//     const updatedRepository = await repository.save();

//     res.json({
//       message: "Repository visibility toggled successfully!",
//       repository: updatedRepository,
//     });
//   } catch (err) {
//     console.error("Error during toggling visibility : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// async function deleteRepositoryById(req, res) {
//   const { id } = req.params;
//   try {
//     const repository = await Repository.findByIdAndDelete(id);
//     if (!repository) {
//       return res.status(404).json({ error: "Repository not found!" });
//     }

//     res.json({ message: "Repository deleted successfully!" });
//   } catch (err) {
//     console.error("Error during deleting repository : ", err.message);
//     res.status(500).send("Server error");
//   }
// }

// module.exports = {
//   createRepository,
//   getAllRepositories,
//   fetchRepositoryById,
//   fetchRepositoryByName,
//   fetchRepositoriesForCurrentUser,
//   updateRepositoryById,
//   toggleVisibilityById,
//   deleteRepositoryById,
// };
