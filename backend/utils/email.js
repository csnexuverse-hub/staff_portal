const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
dotenv.config({ quiet: true });

const emailUser = (process.env.EMAIL_USER || "").trim();
const emailPass = (process.env.EMAIL_PASS || "").trim();

// Reliable transport configuration: pool: false for Gmail to prevent socket drops,
// and 15s timeouts for stable TLS negotiation over cloud/mobile networks.
const transportOptions = {
  pool: false,
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 15000,
};

let transporter;
if (process.env.SMTP_URL) {
  transporter = nodemailer.createTransport({
    url: (process.env.SMTP_URL || "").trim(),
    ...transportOptions,
  });
} else {
  transporter = nodemailer.createTransport({
    service: (process.env.EMAIL_SERVICE || "gmail").trim(),
    auth: {
      user: emailUser,
      pass: emailPass,
    },
    ...transportOptions,
  });
}

async function sendEmail({ to, subject, text, html }) {
  if (!to || (!emailUser && !process.env.SMTP_URL)) {
    return null;
  }

  // Google SMTP requires EMAIL_FROM to match the authenticated Google account
  let fromAddress = (process.env.EMAIL_FROM || "").trim();
  if (!fromAddress || fromAddress.includes("example.com")) {
    fromAddress = emailUser ? `Staff Portal <${emailUser}>` : "Staff Portal <csdevstaffmanagement@gmail.com>";
  }

  const msg = {
    from: fromAddress,
    to,
    // strip line breaks so user-supplied titles can never inject mail headers
    subject: String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 250),
    text,
    html,
  };

  try {
    const info = await transporter.sendMail(msg);
    return info;
  } catch (err) {
    console.error("sendEmail error:", err && err.message ? err.message : err);
    // Suppress so it doesn't crash or delay background tasks
    return null;
  }
}

module.exports = { sendEmail, transporter };

