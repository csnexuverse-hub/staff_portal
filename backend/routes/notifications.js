const express = require("express");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { auth, roleAuth } = require("../middleware/auth");
const { sendEmail } = require("../utils/email");
const { escapeHtml } = require("../utils/sanitize");
const { serverError } = require("../utils/errors");
const { LIMITS, cleanString, idList, isObjectId } = require("../utils/validate");

const router = express.Router();

// Get notifications
router.get("/", auth, async (req, res) => {
  try {
    const notifications = await Notification.find({
      $or: [
        { recipients: req.user.id },
        { recipients: { $size: 0 } }, // broadcasts
      ],
    })
      .populate("sentBy", "name role")
      .sort({ createdAt: -1 });
    res.json(notifications);
  } catch (err) {
    serverError(res, err, "notifications");
  }
});

// Mark all notifications as read for current user
router.put("/read-all", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const notifications = await Notification.find({
      $or: [
        { recipients: userId },
        { recipients: { $size: 0 } },
      ],
      "isRead.user": { $ne: userId },
    });

    const now = new Date();
    await Promise.all(
      notifications.map((n) => {
        n.isRead.push({ user: userId, readAt: now });
        return n.save();
      })
    );

    res.json({
      message: "All notifications marked as read",
      count: notifications.length,
    });
  } catch (err) {
    serverError(res, err, "notifications");
  }
});

// Mark as read
router.put("/:id/read", auth, async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(404).json({ message: "Notification not found" });
    }
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ message: "Notification not found" });
    }

    const currentUserId = req.user.id.toString();
    const isRecipient =
      !notification.recipients ||
      notification.recipients.length === 0 ||
      notification.recipients.some((r) => r.toString() === currentUserId);

    if (!isRecipient && req.user.role !== "superadmin") {
      return res.status(403).json({
        message: "Access denied. You are not an authorized recipient of this notification.",
      });
    }

    if (!notification.isRead.some((r) => r.user.toString() === currentUserId)) {
      notification.isRead.push({ user: req.user.id, readAt: new Date() });
      await notification.save();
    }
    res.json(notification);
  } catch (err) {
    serverError(res, err, "notifications");
  }
});

// Create notification (admins & superadmins only - prevents members spoofing
// "task"/"leave" notifications or phishing other staff)
router.post("/", auth, roleAuth(["admin", "superadmin"]), async (req, res) => {
  const { title, message, type, recipients } = req.body || {};

  const recipientList = idList(Array.isArray(recipients) ? recipients : []);
  if (recipientList === null) {
    return res.status(400).json({ message: "Invalid recipient list" });
  }
  if (recipientList.length > 0) {
    const found = await User.countDocuments({ _id: { $in: recipientList } });
    if (found !== recipientList.length) {
      return res.status(400).json({ message: "One or more recipients were not found" });
    }
  }

  const allowedTypes = ["broadcast", "work", "meeting", "leave"];
  const notifType = allowedTypes.includes(type) ? type : "broadcast";

  try {
    const cleanTitle = cleanString(title, LIMITS.title) || "Notification";
    const cleanMessage = cleanString(message, LIMITS.message);
    if (!cleanMessage) {
      return res.status(400).json({ message: "Notification message is required (max 5000 characters)" });
    }

    const notification = new Notification({
      title: cleanTitle,
      message: cleanMessage,
      type: notifType,
      sentBy: req.user.id,
      recipients: recipientList,
    });
    await notification.save();
    await notification.populate("sentBy", "name role");

    // Real-time socket emission
    try {
      const io = req.app.locals.io;
      if (io) {
        if (notification.recipients && notification.recipients.length > 0) {
          for (const rId of notification.recipients) {
            io.to(rId.toString()).emit("notification:new", {
              title: notification.title,
              message: notification.message,
              type: notification.type,
              sentBy: req.user.name,
              createdAt: notification.createdAt,
            });
            io.to(rId.toString()).emit("notification:update");
          }
        } else {
          io.emit("notification:new", {
            title: notification.title,
            message: notification.message,
            type: notification.type,
            sentBy: req.user.name,
            createdAt: notification.createdAt,
          });
          io.emit("notification:update");
        }
      }
    } catch (e) {
      console.error("Socket notification error:", e);
    }

    res.status(201).json(notification);
  } catch (err) {
    serverError(res, err, "notifications");
  }
});

// Create broadcast announcement (admin/superadmin)
router.post(
  "/broadcast",
  auth,
  roleAuth(["admin", "superadmin"]),
  async (req, res) => {
    const { title, message: rawMessage, recipients } = req.body || {};
    const message = cleanString(rawMessage, LIMITS.message);
    if (!message) {
      return res.status(400).json({ message: "Announcement message is required (max 5000 characters)" });
    }
    const cleanTitle = cleanString(title, LIMITS.title);
    if (cleanTitle === null) {
      return res.status(400).json({ message: "Announcement title must be at most 200 characters" });
    }
    const recipientIds = idList(Array.isArray(recipients) ? recipients : []);
    if (recipientIds === null) {
      return res.status(400).json({ message: "Invalid recipient list" });
    }

    try {
      const notifTitle = cleanTitle ? cleanTitle : "Company Announcement";

      // Determine target recipients based on role and audience
      let targetUsers = [];
      if (recipientIds.length > 0) {
        targetUsers = await User.find({
          _id: { $in: recipientIds, $ne: req.user.id },
          isApproved: { $ne: false },
        }).select("name email _id");
      } else if (req.user.role === "superadmin") {
        // Superadmin broadcast: reaches all Admins and Members
        targetUsers = await User.find({
          _id: { $ne: req.user.id },
          role: { $in: ["admin", "member"] },
          isApproved: { $ne: false },
        }).select("name email _id");
      } else {
        // Admin broadcast: reaches Superadmin, remaining Admins, and Members
        targetUsers = await User.find({
          _id: { $ne: req.user.id },
          role: { $in: ["superadmin", "admin", "member"] },
          isApproved: { $ne: false },
        }).select("name email _id");
      }

      const targetRecipientIds = targetUsers.map((u) => u._id);

      const notification = new Notification({
        title: notifTitle,
        message: message.trim(),
        type: "broadcast",
        sentBy: req.user.id,
        recipients: targetRecipientIds,
      });
      await notification.save();
      await notification.populate("sentBy", "name role");

      // Emit real-time broadcast and updates strictly to recipients
      try {
        const io = req.app.locals.io;
        if (io) {
          const payload = {
            title: notification.title,
            message: notification.message,
            type: "broadcast",
            sentBy: req.user.name,
            createdAt: notification.createdAt,
          };

          for (const u of targetUsers) {
            const rStr = u._id.toString();
            io.to(rStr).emit("notification:new", payload);
            io.to(rStr).emit("notification:broadcast", payload);
            io.to(rStr).emit("notification:update");
          }
        }
      } catch (e) {
        console.error("Socket broadcast error:", e);
      }

      // Send email notifications to target audience (non-blocking)
      (async () => {
        try {
          const appUrl = process.env.APP_URL || "http://localhost:8000";
          const formattedDate = new Date().toLocaleString();

          const safeNotifTitle = escapeHtml(notifTitle);
          const safeSenderName = escapeHtml(req.user.name);
          const safeSenderRole = escapeHtml(req.user.role?.toUpperCase() || "STAFF");
          const safeMessage = escapeHtml(message.trim());

          for (const u of targetUsers) {
            if (!u.email) continue;
            const emailSubject = `📢 Announcement: ${notifTitle}`;
            const html = `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 10px; background: #ffffff;">
                <div style="border-bottom: 2px solid #3b82f6; padding-bottom: 12px; margin-bottom: 20px;">
                  <h2 style="color: #1e293b; margin: 0 0 6px 0; font-size: 20px;">📢 ${safeNotifTitle}</h2>
                  <p style="color: #64748b; font-size: 13px; margin: 0;">Broadcasted by <strong>${safeSenderName}</strong> (${safeSenderRole}) &bull; ${formattedDate}</p>
                </div>
                <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 18px; margin-bottom: 24px; border-radius: 0 8px 8px 0; color: #334155; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">
${safeMessage}
                </div>
                <div style="margin-top: 24px;">
                  <a href="${appUrl}" style="background-color: #3b82f6; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">Open Staff Portal</a>
                </div>
                <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 16px 0;" />
                <p style="color: #94a3b8; font-size: 12px; margin: 0;">CS Development Technologies - Staff Portal Notification System</p>
              </div>
            `;

            sendEmail({
              to: u.email,
              subject: emailSubject,
              text: `${notifTitle}\n\n${message.trim()}\n\nBroadcasted by ${req.user.name}`,
              html,
            }).catch((err) =>
              console.warn(`Failed to send broadcast email to ${u.email}:`, err.message)
            );
          }
        } catch (emailErr) {
          console.error("Error dispatching broadcast emails:", emailErr);
        }
      })();

      res.status(201).json(notification);
    } catch (err) {
      serverError(res, err, "notifications");
    }
  }
);

module.exports = router;

