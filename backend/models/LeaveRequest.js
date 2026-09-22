const mongoose = require("mongoose");

const leaveRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  reason: { type: String, maxlength: 2000 },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  rejectionReason: { type: String, maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
});

leaveRequestSchema.index({ user: 1, createdAt: -1 });
leaveRequestSchema.index({ status: 1 });
leaveRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model("LeaveRequest", leaveRequestSchema);
