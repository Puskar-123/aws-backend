const mongoose = require("mongoose");
const Repository = require("../models/repoModel");
const fs = require("fs");
const path = require("path");


// ✅ CREATE REPOSITORY
async function createRepository(req, res) {
  const {
    owner,
    name,
    issues,
    content,
    description,
    visibility,
    addReadme,
  } = req.body;

  console.log("REQ BODY:", req.body);

  try {
    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Repository name is required!",
      });
     }

    if (!owner || !mongoose.Types.ObjectId.isValid(owner)) {
      return res.status(400).json({
        error: "Invalid or missing User ID!",
      });
    }

    // Duplicate check
    const existingRepo = await Repository.findOne({
      name,
      owner,
    });

    if (existingRepo) {
      return res.status(400).json({
        error: "Repository already exists!",
      });
    }

    // Create repository
    const newRepository = new Repository({
      name: name.trim(),
      description: description || "",
      visibility: visibility || "public",
      owner,
      content: content || [],
      issues: issues || [],
    });

    await newRepository.save();

    // ==========================
    // CREATE README.md
    // ==========================

    if (addReadme) {

      const repoFolder = path.join(
        __dirname,
        "..",
        "uploads",
        newRepository._id.toString()
      );

      if (!fs.existsSync(repoFolder)) {
        fs.mkdirSync(repoFolder, {
          recursive: true,
        });
      }

      const readmePath = path.join(
        repoFolder,
        "README.md"
      );

      const readmeContent = `# ${name}

${description || "No description."}

---

Created using CodeHub 🚀
`;

      fs.writeFileSync(
        readmePath,
        readmeContent
      );

      newRepository.content.push({
        filename: "README.md",
        path: readmePath,
      });

      await newRepository.save();
    }

    res.status(201).json({
      message: "Repository created!",
      repositoryID: newRepository._id,
    });

  } catch (err) {
    console.error("FULL ERROR:", err);

    res.status(500).json({
      error: err.message,
    });
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


