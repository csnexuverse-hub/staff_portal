const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  password: { type: String, required: true },
  mobile: { type: String, required: true, trim: true, maxlength: 20 },
  role: {
    type: String,
    enum: ["member", "admin", "superadmin"],
    default: "member",
  },
  department: { type: String, trim: true, maxlength: 100 },
  assignedAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // for members under admin
  // Incremented on password change / forced logout; tokens carry this value.
  tokenVersion: { type: Number, default: 0 },
  // Self-registered accounts must be approved by a superadmin before login.
  // Existing accounts (field missing) default to approved.
  isApproved: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// Never serialise secrets, even if a route forgets to .select("-password")
function stripSecrets(doc, ret) {
  delete ret.password;
  delete ret.tokenVersion;
  return ret;
}
userSchema.set("toJSON", { transform: stripSecrets });
userSchema.set("toObject", { transform: stripSecrets });

userSchema.index({ role: 1 });
userSchema.index({ department: 1, role: 1 });
userSchema.index({ assignedAdmin: 1 });

module.exports = mongoose.model("User", userSchema);
