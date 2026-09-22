/**
 * Input validation helpers shared by all routes.
 * Every value coming from req.body / req.params / req.query is untrusted.
 */
const mongoose = require("mongoose");

const LIMITS = {
  name: 100,
  email: 254,
  mobile: 20,
  department: 100,
  title: 200,
  description: 10000,
  note: 5000,
  reason: 2000,
  message: 5000,
  url: 2048,
  toolName: 100,
  platform: 100,
  maxRecipients: 1000,
  maxAttendees: 200,
};

function isObjectId(v) {
  return (
    (typeof v === "string" || v instanceof mongoose.Types.ObjectId) &&
    mongoose.Types.ObjectId.isValid(v) &&
    String(new mongoose.Types.ObjectId(String(v))) === String(v).toLowerCase()
  );
}

/** Returns a trimmed string or null if not a string / too long. */
function cleanString(v, max, { allowEmpty = true } = {}) {
  if (v === undefined || v === null) return allowEmpty ? "" : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!allowEmpty && !s) return null;
  if (s.length > max) return null;
  return s;
}

/**
 * Accepts only http(s) URLs. A bare host like "meet.google.com/abc" is
 * normalised to https://... . Returns "" for empty input, null if invalid.
 */
function normalizeUrl(v) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return "";
  if (s.length > LIMITS.url) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Normalises a single id or array of ids into a de-duplicated array of valid ObjectId strings. Returns null if any entry is invalid. */
function idList(v, max = LIMITS.maxRecipients) {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  if (arr.length > max) return null;
  const out = [];
  for (const item of arr) {
    const id = item && typeof item === "object" && item._id ? String(item._id) : item;
    if (!isObjectId(id)) return null;
    if (!out.includes(String(id))) out.push(String(id));
  }
  return out;
}

function isValidDate(v) {
  if (v === undefined || v === null || v === "") return false;
  if (typeof v !== "string" && typeof v !== "number") return false;
  const d = new Date(v);
  return !isNaN(d.getTime());
}

const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/;
function isEmail(v) {
  return typeof v === "string" && v.length <= LIMITS.email && EMAIL_RE.test(v);
}

/** bcrypt only uses the first 72 bytes, so cap there. */
function passwordProblem(pw) {
  if (typeof pw !== "string") return "Password is required";
  if (pw.length < 8) return "Password must be at least 8 characters";
  if (Buffer.byteLength(pw, "utf8") > 72) return "Password is too long (max 72 characters)";
  return null;
}

module.exports = {
  LIMITS,
  isObjectId,
  cleanString,
  normalizeUrl,
  idList,
  isValidDate,
  isEmail,
  passwordProblem,
};
