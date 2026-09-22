const express = require("express");
const Meeting = require("../models/Meeting");
const Notification = require("../models/Notification");
const { auth, roleAuth } = require("../middleware/auth");
const { sendEmail } = require("../utils/email");
const { escapeHtml } = require("../utils/sanitize");
const { serverError } = require("../utils/errors");
const { LIMITS, cleanString, normalizeUrl, isValidDate } = require("../utils/validate");
const User = require("../models/User");
const mongoose = require("mongoose");

const router = express.Router();

// Get meetings
router.get("/", auth, async (req, res) => {
  try {
    let meetings;
    if (req.user.role === "member") {
      meetings = await Meeting.find({
        $or: [{ participants: req.user.id }, { createdBy: req.user.id }],
      })
        .populate("participants", "name email")
        .populate("createdBy", "name role");
    } else if (req.user.role === "superadmin") {
      meetings = await Meeting.find()
        .populate("participants", "name email")
        .populate("createdBy", "name role");
    } else {
      // admin
      meetings = await Meeting.find({
        $or: [{ participants: req.user.id }, { createdBy: req.user.id }],
      })
        .populate("participants", "name email")
        .populate("createdBy", "name role");
    }
    res.json(meetings);
  } catch (err) {
    serverError(res, err, "meetings");
  }
});

// Create meeting
router.post("/", auth, async (req, res) => {
  const { title: rawTitle, description: rawDescription, dateTime, platform: rawPlatform, attendees, link: rawLink } = req.body || {};

  const title = cleanString(rawTitle, LIMITS.title);
  if (!title) {
    return res.status(400).json({ message: "Meeting title is required (max 200 characters)" });
  }
  const description = cleanString(rawDescription, LIMITS.description);
  if (description === null) {
    return res.status(400).json({ message: "Description is too long" });
  }
  const platform = cleanString(rawPlatform, LIMITS.platform);
  if (platform === null) {
    return res.status(400).json({ message: "Invalid platform" });
  }
  const link = normalizeUrl(rawLink);
  if (link === null) {
    return res.status(400).json({ message: "Meeting link must be a valid http(s) URL" });
  }
  if (!isValidDate(dateTime)) {
    return res.status(400).json({ message: "A valid meeting date and time is required" });
  }
  const date = new Date(dateTime);
  const time = date.toTimeString().split(" ")[0]; // HH:MM:SS

  // Normalize attendees into an array of user _id strings
  let rawAttendees;
  if (Array.isArray(attendees)) rawAttendees = attendees;
  else if (typeof attendees === "string") rawAttendees = attendees ? attendees.split(",") : [];
  else if (attendees === undefined || attendees === null) rawAttendees = [];
  else return res.status(400).json({ message: "Invalid attendee list" });
  if (rawAttendees.length > LIMITS.maxAttendees) {
    return res.status(400).json({ message: `A meeting can have at most ${LIMITS.maxAttendees} attendees` });
  }
  const participantIds = [];
  try {
    // Resolve potential emails or padded ids
    for (let a of rawAttendees) {
      if (!a || (typeof a !== "string" && typeof a !== "number")) continue;
      a = String(a).trim();
      if (!a || a.length > LIMITS.email) continue;
      // if it's a valid object id of an existing, approved user, accept it
      if (mongoose.Types.ObjectId.isValid(a) && /^[a-f0-9]{24}$/i.test(a)) {
        const exists = await User.exists({ _id: a, isApproved: { $ne: false } });
        if (exists && !participantIds.includes(a)) participantIds.push(a);
        continue;
      }
      // otherwise try to resolve by email
      const userByEmail = await User.findOne({ email: a.toLowerCase(), isApproved: { $ne: false } }).select("_id");
      if (userByEmail) {
        if (!participantIds.includes(userByEmail._id.toString())) participantIds.push(userByEmail._id.toString());
        continue;
      }
      // try to resolve by name (best-effort)
      const userByName = await User.findOne({ name: a, isApproved: { $ne: false } }).select("_id");
      if (userByName) {
        if (!participantIds.includes(userByName._id.toString())) participantIds.push(userByName._id.toString());
        continue;
      }
      // ignore unknown entries
    }

    // Ensure scheduler is included so they can see the meeting
    if (!participantIds.includes(String(req.user.id))) participantIds.push(String(req.user.id));

    const meeting = new Meeting({
      title,
      description,
      date,
      time,
      participants: participantIds,
      createdBy: req.user.id,
      link: link || "",
      location: platform === "Physical Meeting" ? "TBD" : "",
    });
    await meeting.save();
    await meeting.populate("createdBy", "name role");
    await meeting.populate("participants", "name email");

    // Notify invited participants (save notification and send email)
    try {
      const attendeeIds = participantIds.filter(
        (id) => id.toString() !== req.user.id.toString()
      );
      const participantUsers = await User
        .find({ _id: { $in: attendeeIds } })
        .select("name email");

      const notificationPromises = [];
      const appUrl = process.env.APP_URL || "http://localhost:8000";
      for (const userId of attendeeIds) {
        const notification = new Notification({
          title: `Meeting Invitation: ${title}`,
          message: `You have a meeting: "${title}" on ${date.toDateString()} at ${time}. You have an email with meeting details.`,
          type: "meeting",
          sentBy: req.user.id,
          recipients: [userId],
        });
        notificationPromises.push(notification.save());
      }
      await Promise.all(notificationPromises);

      // Send emails (non-blocking, HTML-sanitized)
      (async () => {
        try {
          const safeTitle = escapeHtml(title);
          const safeDesc = escapeHtml(description || "-");
          const safeCreator = escapeHtml(req.user.name);
          const linkOrPlace = link || (platform === "Physical Meeting" ? meeting.location : "-");
          const safePlatform = escapeHtml(linkOrPlace);

          for (const u of participantUsers) {
            if (!u.email) continue;
            const subject = `Meeting Invitation: ${title}`;
            const participantsNames = participantUsers
              .map((p) => escapeHtml(p.name))
              .join(", ");
            const html = `
              <p>Hi ${escapeHtml(u.name)},</p>
              <p><strong>${safeCreator}</strong> has invited you to a meeting.</p>
              <table>
                <tr><td><strong>Title:</strong></td><td>${safeTitle}</td></tr>
                <tr><td><strong>Description:</strong></td><td>${safeDesc}</td></tr>
                <tr><td><strong>Date:</strong></td><td>${date.toDateString()}</td></tr>
                <tr><td><strong>Time:</strong></td><td>${time}</td></tr>
                <tr><td><strong>Platform/Link:</strong></td><td>${safePlatform}</td></tr>
                <tr><td><strong>Participants:</strong></td><td>${participantsNames}</td></tr>
              </table>
              <p>Open <a href="${appUrl}">Staff Portal</a> for meeting details.</p>
              <p>Regards,<br/>Team</p>
            `;
            sendEmail({ to: u.email, subject, html }).catch((e) =>
              console.error(e),
            );
          }
        } catch (e) {
          console.error("Error sending meeting emails:", e);
        }
      })();
    } catch (e) {
      console.error("Error creating meeting notifications:", e);
    }

    // Emit real-time update to participants
    const io = req.app.locals.io;
    if (io) {
      const attendeeIds = participantIds.filter(
        (id) => id.toString() !== req.user.id.toString()
      );
      const notifPayload = {
        title: `Meeting Invitation: ${title}`,
        message: `You have a meeting: "${title}" on ${date.toDateString()} at ${time}. You have an email with meeting details.`,
        type: "meeting",
        sentBy: req.user.name,
        createdAt: new Date(),
      };

      // Notify meeting creator to update their view without toast
      io.to(req.user.id.toString()).emit("meeting:created", meeting);

      // Notify invited attendees with real-time toast
      for (const userId of attendeeIds) {
        try {
          io.to(userId.toString()).emit("meeting:created", meeting);
          io.to(userId.toString()).emit("notification:new", notifPayload);
          io.to(userId.toString()).emit("notification:update");
        } catch (e) {
          // ignore emit errors
        }
      }
    }


    res.status(201).json(meeting);
  } catch (err) {
    serverError(res, err, "meetings");
  }
});

module.exports = router;
