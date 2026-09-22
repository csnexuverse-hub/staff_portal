const mongoose = require("mongoose");

const aiToolSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  maxUsers: { type: Number, default: 2, min: 1, max: 1000 },
  currentUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("AITool", aiToolSchema);
