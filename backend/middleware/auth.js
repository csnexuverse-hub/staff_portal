const User = require("../models/User");
const { verifyToken } = require("../utils/tokens");

function extractBearer(header) {
  if (typeof header !== "string") return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Resolves a JWT to a live user document. Rejects tokens that are expired,
 * signed with another algorithm, belong to a deleted user, were issued before
 * the last password change (tokenVersion), or belong to an unapproved account.
 */
async function userFromToken(token) {
  if (!token) return { error: "No token provided", status: 401 };
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return { error: "Invalid or expired token", status: 401 };
  }
  const user = await User.findById(decoded.id).select("-password");
  if (!user) return { error: "User not found", status: 401 };
  if ((decoded.tv || 0) !== (user.tokenVersion || 0)) {
    return { error: "Session expired. Please log in again.", status: 401 };
  }
  if (user.isApproved === false) {
    return { error: "Your account is awaiting administrator approval.", status: 403 };
  }
  return { user };
}

const auth = async (req, res, next) => {
  try {
    const result = await userFromToken(extractBearer(req.header("Authorization")));
    if (result.error) return res.status(result.status).json({ message: result.error });
    req.user = result.user;
    next();
  } catch (err) {
    console.error("[auth] middleware error:", err);
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

const roleAuth = (roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role))
    return res.status(403).json({ message: "Access denied" });
  next();
};

module.exports = { auth, roleAuth, userFromToken, extractBearer };
