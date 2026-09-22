const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { auth, roleAuth } = require("../middleware/auth");
const { serverError } = require("../utils/errors");
const { signToken } = require("../utils/tokens");
const { LIMITS, cleanString, isEmail, isObjectId, passwordProblem } = require("../utils/validate");

const router = express.Router();

const BCRYPT_ROUNDS = 12;
// Accounts awaiting approval are only visible to superadmins.
const APPROVED = { isApproved: { $ne: false } };

// Get all users
router.get("/", auth, async (req, res) => {
  try {
    let selectFields = "-password -tokenVersion";
    let filter = {};
    if (req.user.role === "member") {
      // Hide personal mobile numbers from regular staff members
      selectFields = "name email role department assignedAdmin";
      filter = APPROVED;
    } else if (req.user.role === "admin") {
      filter = APPROVED;
    }
    const users = await User.find(filter).select(selectFields);
    res.json(users);
  } catch (err) {
    serverError(res, err, "users.list");
  }
});

// Get team members (admin)
router.get("/team", auth, roleAuth(["admin"]), async (req, res) => {
  try {
    const users = await User.find({ assignedAdmin: req.user._id, ...APPROVED }).select("-password -tokenVersion");
    res.json(users);
  } catch (err) {
    serverError(res, err, "users.team");
  }
});

// Update user details & credentials (superadmin for all, admin for team members)
router.put("/:id", auth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(404).json({ message: "User not found" });
    }
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isSuperAdmin = req.user.role === "superadmin";
    const isAdmin = req.user.role === "admin";
    const isAssignedTeamMember =
      user.role === "member" &&
      user.assignedAdmin &&
      user.assignedAdmin.toString() === req.user._id.toString();

    // Authorization: Superadmin can edit any user; Admin can only edit their own team members
    if (!isSuperAdmin && !(isAdmin && isAssignedTeamMember)) {
      return res.status(403).json({
        message: "Access denied. You do not have permission to update this user.",
      });
    }

    const { name, email, mobile, password, role, department, assignedAdmin, isApproved } = req.body || {};

    if (name !== undefined && name !== null && name !== "") {
      const cleanName = cleanString(name, LIMITS.name);
      if (!cleanName) return res.status(400).json({ message: "Name must be 1-100 characters" });
      user.name = cleanName;
    }

    if (mobile !== undefined && mobile !== null && mobile !== "") {
      const cleanMobile = cleanString(mobile, LIMITS.mobile);
      if (!cleanMobile) return res.status(400).json({ message: "Mobile number must be at most 20 characters" });
      user.mobile = cleanMobile;
    }

    if (email !== undefined && email !== null && email !== "") {
      if (typeof email !== "string" || !isEmail(email.trim().toLowerCase())) {
        return res.status(400).json({ message: "Invalid email format" });
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail !== user.email.toLowerCase()) {
        const existing = await User.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
        if (existing) {
          return res.status(400).json({ message: "Email is already in use by another account" });
        }
        user.email = normalizedEmail;
      }
    }

    let passwordChanged = false;
    if (password !== undefined && password !== null && password !== "") {
      if (typeof password !== "string") return res.status(400).json({ message: "Invalid password" });
      if (password.trim().length > 0) {
        const pwErr = passwordProblem(password);
        if (pwErr) return res.status(400).json({ message: pwErr });
        user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
        // Log the user out everywhere after a reset.
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        passwordChanged = true;
      }
    }

    if (department !== undefined) {
      const cleanDept = department === null ? "" : cleanString(department, LIMITS.department);
      if (cleanDept === null) return res.status(400).json({ message: "Department must be at most 100 characters" });
      user.department = cleanDept;
    }

    // Only superadmin can change roles, reassign admins and approve accounts
    if (isSuperAdmin) {
      if (role !== undefined && role !== null && role !== "") {
        if (!["member", "admin", "superadmin"].includes(role)) {
          return res.status(400).json({ message: "Invalid role" });
        }
        if (user.role === "superadmin" && role !== "superadmin") {
          const otherSuperadmins = await User.countDocuments({ role: "superadmin", _id: { $ne: user._id } });
          if (otherSuperadmins === 0) {
            return res.status(400).json({ message: "Cannot change the role of the only superadmin." });
          }
        }
        user.role = role;
      }
      if (assignedAdmin !== undefined) {
        if (!assignedAdmin) {
          user.assignedAdmin = null;
        } else {
          if (!isObjectId(assignedAdmin)) return res.status(400).json({ message: "Invalid assigned admin" });
          const adminDoc = await User.findOne({ _id: assignedAdmin, role: "admin" }).select("_id");
          if (!adminDoc) return res.status(400).json({ message: "Assigned admin not found" });
          user.assignedAdmin = adminDoc._id;
        }
      }
      if (isApproved !== undefined) {
        if (typeof isApproved !== "boolean") return res.status(400).json({ message: "Invalid approval value" });
        if (!isApproved && String(user._id) === String(req.user._id)) {
          return res.status(400).json({ message: "You cannot revoke your own approval." });
        }
        if (user.isApproved !== isApproved && !isApproved) {
          user.tokenVersion = (user.tokenVersion || 0) + 1; // revoke sessions immediately
        }
        user.isApproved = isApproved;
      }
    }

    await user.save();

    const userObj = user.toObject();
    delete userObj.password;
    delete userObj.tokenVersion;
    // If users reset their own password here, give them a fresh session token.
    if (passwordChanged && String(user._id) === String(req.user._id)) {
      userObj.token = signToken(user);
    }
    res.json(userObj);
  } catch (err) {
    if (err && err.name === "ValidationError") return res.status(400).json({ message: "Invalid user details" });
    serverError(res, err, "users.update");
  }
});

module.exports = router;
