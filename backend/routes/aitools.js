const express = require("express");
const AITool = require("../models/AITool");
const { auth, roleAuth } = require("../middleware/auth");
const { serverError } = require("../utils/errors");
const { LIMITS, cleanString, isObjectId } = require("../utils/validate");

const router = express.Router();

// Get AI tools
router.get("/", auth, async (req, res) => {
  try {
    const tools = await AITool.find();
    res.json(tools);
  } catch (err) {
    serverError(res, err, "aitools.list");
  }
});

// Use AI tool (atomic: capacity check and seat claim happen in a single DB operation)
router.post("/:id/use", auth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(404).json({ message: "AI Tool not found" });
    }
    const tool = await AITool.findById(req.params.id);
    if (!tool) {
      return res.status(404).json({ message: "AI Tool not found" });
    }
    if (tool.currentUsers.some((u) => u.toString() === req.user.id.toString())) {
      return res.json({ message: "Tool accessed" });
    }
    const updated = await AITool.findOneAndUpdate(
      {
        _id: tool._id,
        currentUsers: { $ne: req.user._id },
        $expr: { $lt: [{ $size: "$currentUsers" }, "$maxUsers"] },
      },
      { $addToSet: { currentUsers: req.user._id } },
      { returnDocument: "after" }
    );
    if (!updated) {
      return res.status(400).json({ message: "Tool is at max capacity" });
    }
    res.json({ message: "Tool accessed" });
  } catch (err) {
    serverError(res, err, "aitools.use");
  }
});

// Release AI tool
router.post("/:id/release", auth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(404).json({ message: "AI Tool not found" });
    }
    const updated = await AITool.findByIdAndUpdate(
      req.params.id,
      { $pull: { currentUsers: req.user._id } },
      { returnDocument: "after" }
    );
    if (!updated) {
      return res.status(404).json({ message: "AI Tool not found" });
    }
    res.json({ message: "Tool released" });
  } catch (err) {
    serverError(res, err, "aitools.release");
  }
});

// Manage AI tools (admin, superadmin)
router.post("/", auth, roleAuth(["admin", "superadmin"]), async (req, res) => {
  const { name, maxUsers } = req.body || {};
  const cleanName = cleanString(name, LIMITS.toolName);
  if (!cleanName) {
    return res.status(400).json({ message: "Tool name is required (max 100 characters)" });
  }
  const cleanMaxUsers = maxUsers === undefined || maxUsers === null || maxUsers === "" ? 2 : Number(maxUsers);
  if (!Number.isInteger(cleanMaxUsers) || cleanMaxUsers < 1 || cleanMaxUsers > 1000) {
    return res.status(400).json({ message: "maxUsers must be a whole number between 1 and 1000" });
  }

  try {
    const tool = new AITool({ name: cleanName, maxUsers: cleanMaxUsers });
    await tool.save();
    res.status(201).json(tool);
  } catch (err) {
    serverError(res, err, "aitools.create");
  }
});

module.exports = router;
