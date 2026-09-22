/**
 * Never send internal error details (stack traces, Mongo/Mongoose messages)
 * to the client. Log them server-side and return a generic message.
 */
function serverError(res, err, context = "request") {
  console.error(`[${context}]`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  return res.status(500).json({ message: "Server error. Please try again." });
}

module.exports = { serverError };
