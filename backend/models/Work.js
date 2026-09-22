const mongoose = require("mongoose");

const workSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 10000 },
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  status: {
    type: String,
    enum: ["assigned", "accepted", "in_progress", "completed", "confirmed"],
    default: "assigned",
  },
  priority: {
    type: String,
    enum: ["Low", "Medium", "High"],
    default: "Medium",
  },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  deadline: { type: Date },
  driveLink: { type: String, trim: true, default: "", maxlength: 2048 },
  notes: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      note: { type: String, maxlength: 6000 },
      progress: Number,
      date: Date,
    },
  ],
  createdAt: { type: Date, default: Date.now },
});

workSchema.index({ assignedTo: 1 });
workSchema.index({ assignedBy: 1 });
workSchema.index({ status: 1 });
workSchema.index({ createdAt: -1 });
workSchema.index({ assignedTo: 1, status: 1 });

module.exports = mongoose.model("Work", workSchema);
