const mongoose = require("mongoose");

const meetingSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, maxlength: 10000 },
  date: { type: Date, required: true },
  time: { type: String, required: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  link: { type: String, maxlength: 2048 }, // for online meetings
  location: { type: String }, // for physical
  createdAt: { type: Date, default: Date.now },
});

meetingSchema.index({ participants: 1 });
meetingSchema.index({ createdBy: 1 });
meetingSchema.index({ date: -1 });

module.exports = mongoose.model("Meeting", meetingSchema);
