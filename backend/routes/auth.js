const express = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { auth } = require("../middleware/auth");
const { sendEmail } = require("../utils/email");
const { signToken } = require("../utils/tokens");
const { serverError } = require("../utils/errors");
const { LIMITS, cleanString, isEmail, passwordProblem } = require("../utils/validate");

const router = express.Router();

const BCRYPT_ROUNDS = 12;
// Used so that "unknown email" and "wrong password" take the same time (prevents user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser-not-a-real-password", BCRYPT_ROUNDS);

const envFlag = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
};

const allowedDomains = () =>
  (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

const MOBILE_RE = /^[0-9+\-\s()]{6,20}$/;

// Register
router.post("/register", async (req, res) => {
  if (!envFlag("REGISTRATION_ENABLED", true)) {
    return res.status(403).json({ message: "Self-registration is disabled. Please contact your administrator." });
  }

  const { name, email, password, mobile } = req.body || {};

  const cleanName = cleanString(name, LIMITS.name, { allowEmpty: false });
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cleanMobile = cleanString(mobile, LIMITS.mobile, { allowEmpty: false });

  if (!cleanName || !cleanEmail || typeof password !== "string" || !password || !cleanMobile) {
    return res.status(400).json({ message: "All fields are required (name max 100 characters, mobile max 20)" });
  }
  if (!isEmail(cleanEmail)) {
    return res.status(400).json({ message: "Invalid email format" });
  }
  if (!MOBILE_RE.test(cleanMobile)) {
    return res.status(400).json({ message: "Invalid mobile number" });
  }
  const pwErr = passwordProblem(password);
  if (pwErr) return res.status(400).json({ message: pwErr });

  const domains = allowedDomains();
  if (domains.length > 0) {
    const domain = cleanEmail.split("@").pop();
    if (!domains.includes(domain)) {
      return res.status(403).json({ message: "Please register with your company email address." });
    }
  }

  try {
    const existing = await User.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Bootstrap: the configured email becomes the first superadmin (only while no superadmin exists).
    const bootstrapEmail = (process.env.BOOTSTRAP_SUPERADMIN_EMAIL || "").trim().toLowerCase();
    let role = "member";
    let isApproved = !envFlag("REQUIRE_APPROVAL", true);
    if (bootstrapEmail && cleanEmail === bootstrapEmail) {
      const superadminExists = await User.exists({ role: "superadmin" });
      if (!superadminExists) {
        role = "superadmin";
        isApproved = true;
      }
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = new User({
      name: cleanName,
      email: cleanEmail,
      password: hashedPassword,
      mobile: cleanMobile,
      role,
      isApproved,
    });
    await user.save();

    if (!isApproved) {
      // Let superadmins know somebody is waiting for approval (best-effort).
      (async () => {
        try {
          const superadmins = await User.find({ role: "superadmin" }).select("_id");
          if (superadmins.length) {
            await Notification.create({
              title: "New registration awaiting approval",
              message: `${cleanName} (${cleanEmail}) registered and is waiting for approval. Open User & Role Management to approve.`,
              type: "broadcast",
              sentBy: user._id,
              recipients: superadmins.map((s) => s._id),
            });
            const io = req.app.locals.io;
            if (io) superadmins.forEach((s) => io.to(String(s._id)).emit("notification:update"));
          }
        } catch (e) {
          console.error("[auth] pending-registration notify failed:", e.message);
        }
      })();
    }

    sendEmail({
      to: user.email,
      subject: "Welcome to Staff Portal",
      text: isApproved
        ? `Hello ${user.name}, your account has been created.`
        : `Hello ${user.name}, your account has been created and is awaiting administrator approval.`,
    }).catch((e) => console.warn("email send failed:", e.message));

    res.status(201).json({
      message: isApproved
        ? "Registration successful. Please login."
        : "Registration successful. Your account is awaiting administrator approval - you can log in once it is approved.",
      pendingApproval: !isApproved,
    });
  } catch (err) {
    if (err && err.code === 11000) return res.status(400).json({ message: "User already exists" });
    if (err && err.name === "ValidationError") return res.status(400).json({ message: "Invalid registration details" });
    serverError(res, err, "auth.register");
  }
});

// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ message: "Missing email or password" });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password || cleanEmail.length > LIMITS.email || password.length > 1024) {
    return res.status(400).json({ message: "Missing email or password" });
  }

  try {
    const user = await User.findOne({ email: cleanEmail });
    const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    if (user.isApproved === false) {
      return res.status(403).json({ message: "Your account is awaiting administrator approval." });
    }

    const token = signToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
        department: user.department,
        userId: user._id, // for compatibility
      },
    });
  } catch (err) {
    serverError(res, err, "auth.login");
  }
});

// Get profile
router.get("/profile", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password -tokenVersion");
    res.json(user);
  } catch (err) {
    serverError(res, err, "auth.profile");
  }
});

// Update profile (all roles: member, admin, superadmin)
router.put("/profile", auth, async (req, res) => {
  try {
    const { name, email, mobile, password, currentPassword } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    let newEmail = null;
    if (email !== undefined && email !== null && email !== "") {
      if (typeof email !== "string" || !isEmail(email.trim().toLowerCase())) {
        return res.status(400).json({ message: "Invalid email format" });
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail !== user.email.toLowerCase()) newEmail = normalizedEmail;
    }
    const wantsPasswordChange = typeof password === "string" && password.trim().length > 0;

    // Sensitive changes require the current password (protects against stolen sessions).
    if (newEmail || wantsPasswordChange) {
      if (typeof currentPassword !== "string" || !currentPassword) {
        return res.status(400).json({ message: "Please enter your current password to change your email or password." });
      }
      const ok = await bcrypt.compare(currentPassword, user.password);
      if (!ok) return res.status(400).json({ message: "Current password is incorrect." });
    }

    if (name !== undefined) {
      const cleanName = cleanString(name, LIMITS.name);
      if (cleanName === null) return res.status(400).json({ message: "Name must be at most 100 characters" });
      if (cleanName) user.name = cleanName;
    }

    if (mobile !== undefined) {
      const cleanMobile = cleanString(mobile, LIMITS.mobile);
      if (cleanMobile === null || (cleanMobile && cleanMobile !== user.mobile && !MOBILE_RE.test(cleanMobile))) {
        return res.status(400).json({ message: "Invalid mobile number" });
      }
      if (cleanMobile) user.mobile = cleanMobile;
    }

    if (newEmail) {
      const existing = await User.findOne({ email: newEmail, _id: { $ne: user._id } });
      if (existing) {
        return res.status(400).json({ message: "Email is already in use by another account" });
      }
      user.email = newEmail;
    }

    let newToken = null;
    if (wantsPasswordChange) {
      const pwErr = passwordProblem(password);
      if (pwErr) return res.status(400).json({ message: pwErr });
      user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
      // Invalidate every other session, then issue a fresh token for this one.
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    await user.save();
    if (wantsPasswordChange) newToken = signToken(user);

    const body = {
      id: user._id,
      userId: user._id,
      _id: user._id,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
      department: user.department,
      assignedAdmin: user.assignedAdmin,
    };
    if (newToken) body.token = newToken;
    res.json(body);
  } catch (err) {
    if (err && err.name === "ValidationError") return res.status(400).json({ message: "Invalid profile details" });
    serverError(res, err, "auth.updateProfile");
  }
});

module.exports = router;
