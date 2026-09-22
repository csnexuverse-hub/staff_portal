const jwt = require("jsonwebtoken");

/** Signs a session token. `tv` (token version) lets us revoke old tokens on password change. */
function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d", algorithm: "HS256" }
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
}

module.exports = { signToken, verifyToken };
