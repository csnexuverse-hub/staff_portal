const express = require("express");
const Attendance = require("../models/Attendance");
const LeaveRequest = require("../models/LeaveRequest");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { auth, roleAuth } = require("../middleware/auth");
const { sendEmail } = require("../utils/email");
const { escapeHtml } = require("../utils/sanitize");
const { serverError } = require("../utils/errors");
const { LIMITS, cleanString, isObjectId, isValidDate } = require("../utils/validate");

const router = express.Router();

// Check in
router.post("/checkin", auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    let attendance = await Attendance.findOne({
      user: req.user.id,
      date: today,
    });
    if (!attendance) {
      attendance = new Attendance({
        user: req.user.id,
        date: today,
        checkIn: new Date(),
      });
      await attendance.save();
    } else if (!attendance.checkIn) {
      attendance.checkIn = new Date();
      await attendance.save();
    }
    // Emit attendance update
    try {
      const io = req.app.locals.io;
      if (io)
        io.to(req.user.id.toString()).emit("attendance:update", {
          user: req.user.id,
          checkIn: attendance.checkIn,
        });
      // Also emit to assigned admin
      const userDoc = req.user;
      if (userDoc && userDoc.assignedAdmin) {
        io.to(userDoc.assignedAdmin.toString()).emit("attendance:update", {
          user: req.user.id,
          checkIn: attendance.checkIn,
        });
      }
    } catch (e) { }
    res.json(attendance);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Check out
router.post("/checkout", auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const attendance = await Attendance.findOne({
      user: req.user.id,
      date: today,
    });
    if (attendance) {
      attendance.checkOut = new Date();
      await attendance.save();
      // Emit attendance update
      try {
        const io = req.app.locals.io;
        if (io)
          io.to(req.user.id.toString()).emit("attendance:update", {
            user: req.user.id,
            checkOut: attendance.checkOut,
          });
        // Also emit to assigned admin
        const userDoc = req.user;
        if (userDoc && userDoc.assignedAdmin) {
          io.to(userDoc.assignedAdmin.toString()).emit("attendance:update", {
            user: req.user.id,
            checkOut: attendance.checkOut,
          });
        }
      } catch (e) { }
    }
    res.json(attendance);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Get attendance for user
router.get("/", auth, async (req, res) => {
  try {
    const attendances = await Attendance.find({ user: req.user.id });
    res.json(attendances);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Get team attendance (admin)
router.get("/team", auth, roleAuth(["admin"]), async (req, res) => {
  try {
    const adminId = req.user._id || req.user.id;
    const query = {
      $or: [
        { assignedAdmin: adminId },
        { assignedAdmin: adminId.toString() },
      ],
    };
    if (req.user.department) {
      query.$or.push({ department: req.user.department, role: "member" });
    }
    const assignedUsers = await User.find(query);
    const userIds = assignedUsers.map((u) => u._id);

    const attendances = await Attendance.find({
      user: { $in: userIds },
    }).populate("user", "name email role department");
    res.json(attendances);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Get all attendance (superadmin)
router.get("/all", auth, roleAuth(["superadmin"]), async (req, res) => {
  try {
    const attendances = await Attendance.find().populate(
      "user",
      "name email role department",
    );
    res.json(attendances);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Get admins attendance (superadmin)
router.get("/admins", auth, roleAuth(["superadmin"]), async (req, res) => {
  try {
    const admins = await User.find({ role: "admin" });
    const adminIds = admins.map((a) => a._id);

    const attendances = await Attendance.find({
      user: { $in: adminIds },
    }).populate("user", "name email role department");
    res.json(attendances);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Get all leave requests (superadmin) - only admin requests
router.get("/leave/all", auth, roleAuth(["superadmin"]), async (req, res) => {
  try {
    const leaves = await LeaveRequest.find()
      .populate("user", "name email role")
      .populate("approvedBy", "name");
    res.json(leaves);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Get my leave requests
router.get("/leave/my", auth, async (req, res) => {
  try {
    const leaves = await LeaveRequest.find({ user: req.user.id }).populate(
      "approvedBy",
      "name",
    );
    res.json(leaves);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Get team leave requests (admin)
router.get("/leave/team", auth, roleAuth(["admin"]), async (req, res) => {
  try {
    // Find users assigned to this admin
    const assignedUsers = await User.find({
      assignedAdmin: req.user.id,
    });
    const userIds = assignedUsers.map((u) => u._id);

    const leaves = await LeaveRequest.find({
      user: { $in: userIds },
    })
      .populate("user", "name email")
      .populate("approvedBy", "name");
    res.json(leaves);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Request leave
router.post("/leave", auth, async (req, res) => {
  const { startDate: rawStart, endDate: rawEnd, reason: rawReason } = req.body || {};
  if (!rawStart || !rawEnd) {
    return res.status(400).json({ message: "Start date and end date are required" });
  }
  if (!isValidDate(rawStart) || !isValidDate(rawEnd)) {
    return res.status(400).json({ message: "Invalid date format provided" });
  }
  const reason = cleanString(rawReason, LIMITS.reason);
  if (reason === null) {
    return res.status(400).json({ message: "Reason must be text of at most 2000 characters" });
  }
  const start = new Date(rawStart);
  const end = new Date(rawEnd);
  // Use normalised ISO dates in messages - never echo raw client input.
  const startDate = start.toISOString().split("T")[0];
  const endDate = end.toISOString().split("T")[0];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (start <= today) {
    return res.status(400).json({ message: "Leave must be requested a day before" });
  }
  if (end < start) {
    return res.status(400).json({ message: "End date cannot be before start date" });
  }

  try {
    const leave = new LeaveRequest({
      user: req.user.id,
      startDate: start,
      endDate: end,
      reason,
    });
    await leave.save();

    // Notify admin or superadmin and send email
    try {
      if (req.user.role === "admin") {
        // Notify superadmins
        const superadmins = await User.find({ role: "superadmin" }).select(
          "name email",
        );
        for (const sa of superadmins) {
          const notification = new Notification({
            title: "Leave Request",
            message: `${req.user.name} has requested leave from ${startDate} to ${endDate}`,
            type: "leave",
            sentBy: req.user.id,
            recipients: [sa._id],
          });
          await notification.save();
          // send email (non-blocking)
          (async () => {
            try {
              if (sa.email) {
                const subject = `Leave Request: ${req.user.name}`;
                const safeName = escapeHtml(req.user.name);
                const safeReason = escapeHtml(reason || "-");
                const safeStart = escapeHtml(startDate);
                const safeEnd = escapeHtml(endDate);
                const html = `
                  <p>Hi ${escapeHtml(sa.name)},</p>
                  <p>${safeName} has requested leave from <strong>${safeStart}</strong> to <strong>${safeEnd}</strong>.</p>
                  <p><strong>Reason:</strong> ${safeReason} </p>
                  <p>Please review and approve/reject the request.</p>
                  <p>Regards,<br/>Team</p>
                `;
                sendEmail({ to: sa.email, subject, html }).catch((e) =>
                  console.error(e),
                );
              }
            } catch (e) {
              console.error(
                "Error sending leave request email to superadmin:",
                e,
              );
            }
          })();
        }
      } else {
        // Notify assigned admin
        const userDoc = await User.findById(req.user.id).populate(
          "assignedAdmin",
        );
        if (userDoc && userDoc.assignedAdmin) {
          const admin = await User.findById(userDoc.assignedAdmin).select(
            "name email",
          );
          const notification = new Notification({
            title: "Leave Request",
            message: `${req.user.name} has requested leave from ${startDate} to ${endDate}`,
            type: "leave",
            sentBy: req.user.id,
            recipients: [admin ? admin._id : null],
          });
          await notification.save();

          // send email to assigned admin
          (async () => {
            try {
              if (admin && admin.email) {
                const subject = `Leave Request: ${req.user.name}`;
                const safeName = escapeHtml(req.user.name);
                const safeReason = escapeHtml(reason || "-");
                const safeStart = escapeHtml(startDate);
                const safeEnd = escapeHtml(endDate);
                const html = `
                  <p>Hi ${escapeHtml(admin.name)},</p>
                  <p>${safeName} has requested leave from <strong>${safeStart}</strong> to <strong>${safeEnd}</strong>.</p>
                  <p><strong>Reason:</strong> ${safeReason} </p>
                  <p>Please review and approve/reject the request.</p>
                  <p>Regards,<br/>Team</p>
                `;
                sendEmail({ to: admin.email, subject, html }).catch((e) =>
                  console.error(e),
                );
              }
            } catch (e) {
              console.error("Error sending leave request email to admin:", e);
            }
          })();
        } else {
          // No assigned admin: route to superadmins only (never broadcast to all staff)
          const superadmins = await User.find({ role: "superadmin" }).select("_id");
          if (superadmins.length > 0) {
            const notification = new Notification({
              title: "Leave Request",
              message: `${req.user.name} has requested leave from ${startDate} to ${endDate}`,
              type: "leave",
              sentBy: req.user.id,
              recipients: superadmins.map((sa) => sa._id),
            });
            await notification.save();
          }
        }
      }

      // Emit real-time notification
      try {
        const io = req.app.locals.io;
        if (io) {
          if (req.user.role === "admin") {
            // Notify superadmins
            const superadmins = await User.find({ role: "superadmin" });
            superadmins.forEach((sa) =>
              io.to(sa._id.toString()).emit("notification:update", {}),
            );
          } else {
            // Notify assigned admin
            const userDoc2 = await User.findById(req.user.id);
            if (userDoc2 && userDoc2.assignedAdmin) {
              io.to(userDoc2.assignedAdmin.toString()).emit(
                "notification:update",
                {},
              );
            } else {
              const superadmins = await User.find({ role: "superadmin" }).select("_id");
              superadmins.forEach((sa) => io.to(sa._id.toString()).emit("notification:update", {}));
            }
          }
        }
      } catch (e) { }
    } catch (err) {
      console.error("Error in leave notification flow:", err);
    }

    res.status(201).json(leave);
  } catch (err) {
    serverError(res, err, "attendance");
  }
});

// Approve/reject leave (admin/superadmin)
router.put(
  "/leave/:id",
  auth,
  roleAuth(["admin", "superadmin"]),
  async (req, res) => {
    const { status, reason: rawReason } = req.body || {};
    const reason = cleanString(rawReason, LIMITS.reason);
    if (reason === null) {
      return res.status(400).json({ message: "Reason must be text of at most 2000 characters" });
    }

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status. Must be 'approved' or 'rejected'." });
    }

    try {
      if (!isObjectId(req.params.id)) {
        return res.status(404).json({ message: "Leave request not found" });
      }
      const leave = await LeaveRequest.findById(req.params.id).populate("user", "name email role department assignedAdmin");
      if (!leave) {
        return res.status(404).json({ message: "Leave request not found" });
      }

      // Prevent self-approval of leaves
      if (leave.user && leave.user._id && leave.user._id.toString() === req.user.id.toString()) {
        return res.status(403).json({
          message: "Access denied. You cannot approve or reject your own leave request.",
        });
      }

      // Enforce team/department boundary for Admin
      if (req.user.role === "admin") {
        // Admins may only decide on leave of regular members (admin leave goes to superadmins)
        if (!leave.user || leave.user.role !== "member") {
          return res.status(403).json({
            message: "Access denied. Only a superadmin can approve or reject this leave request.",
          });
        }
        const isAssigned = leave.user && leave.user.assignedAdmin && leave.user.assignedAdmin.toString() === req.user.id.toString();
        const isSameDept = req.user.department && leave.user && leave.user.department === req.user.department;
        if (!isAssigned && !isSameDept) {
          return res.status(403).json({
            message: "Access denied. You can only approve or reject leaves for members in your department.",
          });
        }
      }

      leave.status = status;
      leave.approvedBy = req.user.id;
      if (status === "rejected") {
        leave.rejectionReason = reason;
      }
      await leave.save();

      // Notify user (save notification and send email)
      const notification = new Notification({
        title: "Leave Request Update",
        message: `Your leave request has been ${status}${reason ? ": " + reason : ""}`,
        type: "leave",
        sentBy: req.user.id,
        recipients: [leave.user._id],
      });
      await notification.save();

      // Send email to requester (non-blocking, HTML-sanitized)
      (async () => {
        try {
          const requester = await User.findById(leave.user._id).select(
            "name email",
          );
          if (requester && requester.email) {
            const subject = `Leave Request ${status === "approved" ? "Approved" : "Rejected"}`;
            const safeStatus = escapeHtml(status);
            const safeReason = escapeHtml(leave.rejectionReason || "");
            const safeStart = escapeHtml(new Date(leave.startDate).toDateString());
            const safeEnd = escapeHtml(new Date(leave.endDate).toDateString());
            const html = `
              <p>Hi ${escapeHtml(requester.name)},</p>
              <p>Your leave request from <strong>${safeStart}</strong> to <strong>${safeEnd}</strong> has been <strong>${safeStatus}</strong>.</p>
              ${status === "rejected" && safeReason ? `<p><strong>Reason:</strong> ${safeReason}</p>` : ""}
              <p>Regards,<br/>Team</p>
            `;
            sendEmail({ to: requester.email, subject, html }).catch((e) =>
              console.error(e),
            );
          }
        } catch (e) {
          console.error("Error sending leave update email:", e);
        }
      })();

      // Emit real-time update
      try {
        const io = req.app.locals.io;
        if (io) io.to(leave.user._id.toString()).emit("leave:update", {});
      } catch (e) { }

      res.json(leave);
    } catch (err) {
      serverError(res, err, "attendance");
    }
  },
);

module.exports = router;