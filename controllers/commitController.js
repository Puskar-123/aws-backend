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

    const commit = await commitRepo(id, message, req.body);

    res.status(200).json({
      message: "Commit created successfully!",
      commit,
    });
  } catch (err) {
    console.error(err);
    const status = err.message === "Invalid repository ID"
      ? 400
      : (err.message === "Repository not found" ? 404 : (err.status || 500));
    res.status(status).json({ error: status === 500 ? "Commit failed" : err.message });
  }
}

module.exports = {
  createCommit,
};
