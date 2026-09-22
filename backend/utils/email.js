const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
dotenv.config({ quiet: true });

// Create transporter supporting SMTP URL or service+auth with connection pooling and fast timeouts
let transporter;
const transportOptions = {
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  connectionTimeout: 4000,
  greetingTimeout: 4000,
  socketTimeout: 4000,
};

if (process.env.SMTP_URL) {
  transporter = nodemailer.createTransport({
    url: process.env.SMTP_URL,
    ...transportOptions,
  });
} else {
  transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    ...transportOptions,
  });
}

async function sendEmail({ to, subject, text, html }) {
  if (!to || (!process.env.EMAIL_USER && !process.env.SMTP_URL)) {
    return;
  }
  const msg = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to,
    // strip line breaks so user-supplied titles can never inject mail headers
    subject: String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 250),
    text,
    html,
  };
  try {
    return await transporter.sendMail(msg);
  } catch (err) {
    console.error("sendEmail error:", err && err.message ? err.message : err);
    // Suppress so it doesn't crash or delay background tasks
    return null;
  }
}

module.exports = { sendEmail };
