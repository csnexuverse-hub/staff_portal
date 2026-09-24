const express = require("express");
const dns = require("dns");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

dotenv.config({ quiet: true });

const dnsServers = (process.env.DNS_SERVERS || "")
  .split(",")
  .map((server) => server.trim())
  .filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

const isProduction = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Startup configuration checks
// ---------------------------------------------------------------------------
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error("\n❌ CRITICAL SECURITY ERROR: JWT_SECRET is missing or shorter than 32 characters.");
  console.error("Generate one with:  node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"\n");
  process.exit(1);
}
if (isProduction && !process.env.MONGO_URI) {
  console.error("\n❌ MONGO_URI must be set in production.\n");
  process.exit(1);
}

const { userFromToken, extractBearer } = require("./middleware/auth");
const { verifyToken } = require("./utils/tokens");

// Allowed websocket origin for the CSP (same host as the site)
const wsOrigins = [];
if (process.env.APP_URL) {
  try {
    const u = new URL(process.env.APP_URL);
    wsOrigins.push(`${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`);
  } catch {
    /* ignore malformed APP_URL */
  }
}
if (!isProduction) wsOrigins.push("ws://localhost:5000", "http://localhost:5000", "ws://127.0.0.1:5000", "http://127.0.0.1:5000");

const app = express();
app.disable("x-powered-by");

// Render (and most PaaS) sit behind one reverse proxy. Needed so req.ip is the
// real client IP - otherwise every user shares a single rate-limit bucket.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));

// ---------------------------------------------------------------------------
// Security headers (Content Security Policy blocks data exfiltration to
// foreign hosts even if a script ever slipped through)
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // Inline scripts / onclick handlers are used by the single-page UI.
        // 'unsafe-eval' is only needed by the Tailwind Play CDN runtime; remove it
        // if you switch to a pre-built tailwind.css file.
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        // Only our own origin: blocks sending data (e.g. tokens) to other sites
        connectSrc: ["'self'", ...wsOrigins],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  })
);

// ---------------------------------------------------------------------------
// Rate limiting (brute-force & abuse protection)
// ---------------------------------------------------------------------------
// Authenticated traffic is limited per user (an office behind one NAT IP must
// not lock itself out); anonymous traffic is limited per IP.
const apiKey = (req) => {
  const token = extractBearer(req.headers.authorization);
  if (token) {
    try {
      return "user:" + verifyToken(token).id;
    } catch {
      /* fall through to IP */
    }
  }
  return "ip:" + rateLimit.ipKeyGenerator(req.ip);
};

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.API_RATE_LIMIT || 1000), // requests per user (or per IP) per window
  keyGenerator: apiKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests from this IP, please try again after 15 minutes." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT || 20), // failed login/register attempts per IP per window
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication attempts, please try again after 15 minutes." },
});

// Limits outbound email / notification fan-out per IP
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.WRITE_RATE_LIMIT || 60),
  keyGenerator: apiKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please slow down and try again later." },
});

app.use("/api/", apiLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.post("/api/meetings", writeLimiter);
app.post("/api/notifications", writeLimiter);
app.post("/api/notifications/broadcast", writeLimiter);

// ---------------------------------------------------------------------------
// CORS - same-origin in production by default; extra origins via FRONTEND_URL
// (comma separated). Localhost is only allowed outside production.
// ---------------------------------------------------------------------------
const devOrigins = [
  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:8000",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:5500",
];
const configuredOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter((o) => o && o !== "*");
const allowedOrigins = [...configuredOrigins, ...(isProduction ? [] : devOrigins)];

app.use(
  "/api",
  cors({
    origin: function (origin, callback) {
      // No Origin header = same-origin request or non-browser client (auth still required).
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: false,
  })
);

app.use(express.json({ limit: "100kb" }));

// Handle malformed JSON / oversized body errors gracefully
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON payload" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large" });
  }
  next(err);
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
mongoose.set("strictQuery", true);
mongoose
  .connect(process.env.MONGO_URI || "mongodb://localhost:27017/staffmanagement")
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err.message));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", db: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
const attendanceRoutes = require("./routes/attendance");
app.use("/api/attendance", attendanceRoutes);
app.use("/api/meetings", require("./routes/meetings"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/aitools", require("./routes/aitools"));
app.use("/api/reports", require("./routes/reports"));

// Unknown API routes -> JSON 404 (never fall through to the SPA)
app.use("/api", (req, res) => {
  res.status(404).json({ message: "Not found" });
});

// Serve frontend static assets (single-service deployment on Render)
app.use(
  express.static(path.join(__dirname, "../frontend"), {
    dotfiles: "deny",
    index: "index.html",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  })
);

// SPA fallback for non-API web traffic
app.get("{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
    return next();
  }
  const indexPath = path.join(__dirname, "../frontend/index.html");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

// Final error handler - never leak stack traces or internal messages
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[unhandled]", err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(err && err.status && err.status < 500 ? err.status : 500).json({
    message: err && err.status && err.status < 500 ? "Bad request" : "Server error. Please try again.",
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ["GET", "POST"],
    credentials: false,
  },
  maxHttpBufferSize: 1e5, // 100 KB per message
});

// Make io available to routes
app.locals.io = io;

// Socket Authentication Middleware - same checks as the REST API
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || extractBearer(socket.handshake.headers?.authorization);
    const result = await userFromToken(token);
    if (result.error) return next(new Error("Authentication error: " + result.error));
    socket.user = { id: String(result.user._id), role: result.user.role };
    next();
  } catch (err) {
    return next(new Error("Authentication error: Invalid or expired token"));
  }
});

io.on("connection", (socket) => {
  // Every socket is automatically placed in its own user room (also restores
  // real-time updates after reconnects).
  socket.join(socket.user.id);

  socket.on("join", (userId) => {
    const targetUserId = (userId || "").toString();
    // Users may only ever join their own room.
    if (targetUserId !== socket.user.id) {
      console.warn(`[socket] Forbidden: User ${socket.user.id} attempted to join room ${targetUserId}`);
      return;
    }
    socket.join(targetUserId);
  });

  socket.on("disconnect", () => {});
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

// ---------------------------------------------------------------------------
// 8-Hour Shift Automatic Checkout Background Job (runs every 60s)
// ---------------------------------------------------------------------------
const AUTO_CHECKOUT_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  if (mongoose.connection.readyState === 1 && typeof attendanceRoutes.autoCheckoutExpiredRecords === "function") {
    attendanceRoutes.autoCheckoutExpiredRecords({}, io).catch((err) => {
      console.error("[autoCheckout:timer]", err && err.message ? err.message : err);
    });
  }
}, AUTO_CHECKOUT_INTERVAL_MS);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

