const { commitRepo } = require("./commit");

async function createCommit(req, res) {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Commit message is required",
      });
    }

    await commitRepo(id, message);

    res.status(200).json({
      message: "Commit created successfully!",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Commit failed",
    });
  }
}

module.exports = {
  createCommit,
};
