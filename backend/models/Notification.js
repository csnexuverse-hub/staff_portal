const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 300 },
  message: { type: String, required: true, maxlength: 10000 },
  type: {
    type: String,
    enum: ["broadcast", "work", "meeting", "leave"],
    default: "broadcast",
  },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], // empty for broadcast to all
  isRead: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      readAt: Date,
    },
  ],
  createdAt: { type: Date, default: Date.now },
});

notificationSchema.index({ recipients: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
