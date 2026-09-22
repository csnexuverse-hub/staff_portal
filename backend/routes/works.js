const express = require("express");
const Work = require("../models/Work");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { auth, roleAuth } = require("../middleware/auth");
const { sendEmail } = require("../utils/email");
const { escapeHtml } = require("../utils/sanitize");
const { serverError } = require("../utils/errors");
const { LIMITS, cleanString, normalizeUrl, idList, isObjectId, isValidDate } = require("../utils/validate");

const router = express.Router();

// Get works for user
router.get("/", auth, async (req, res) => {
  try {
    let works;
    if (req.user.role === "member") {
      works = await Work.find({ assignedTo: req.user._id }).populate(
        "assignedBy assignedTo",
        "name",
      );
    } else if (req.user.role === "admin") {
      const teamUsers = await User.find({ assignedAdmin: req.user._id }).select("_id");
      const teamUserIds = teamUsers.map((u) => u._id);
      works = await Work.find({
        $or: [
          { assignedBy: req.user._id },
          { assignedTo: req.user._id },
          { assignedTo: { $in: teamUserIds } },
        ],
      }).populate("assignedBy assignedTo", "name");
    } else {
      // superadmin can see all
      works = await Work.find().populate("assignedTo assignedBy", "name");
    }
    res.json(works);
  } catch (err) {
    serverError(res, err, "works");
  }
});

// Create work (admin, superadmin)
router.post("/", auth, roleAuth(["admin", "superadmin"]), async (req, res) => {
  const { title, description, assignedTo, deadline, priority, driveLink } = req.body || {};
  try {
    const cleanTitle = cleanString(title, LIMITS.title);
    if (cleanTitle === null) {
      return res.status(400).json({ message: "Work title must be at most 200 characters" });
    }
    if (!cleanTitle) {
      return res.status(400).json({ message: "Work title is required" });
    }
    const cleanDescription = cleanString(description, LIMITS.description);
    if (cleanDescription === null) {
      return res.status(400).json({ message: "Description is too long" });
    }
    const cleanDriveLink = normalizeUrl(driveLink);
    if (cleanDriveLink === null) {
      return res.status(400).json({ message: "Drive link must be a valid http(s) URL" });
    }
    if (priority !== undefined && priority !== null && priority !== "" && !["Low", "Medium", "High"].includes(priority)) {
      return res.status(400).json({ message: "Invalid priority" });
    }
    let cleanDeadline;
    if (deadline !== undefined && deadline !== null && deadline !== "") {
      if (!isValidDate(deadline)) return res.status(400).json({ message: "Invalid deadline" });
      cleanDeadline = new Date(deadline);
    }

    const targetAssignees = idList(assignedTo);
    if (targetAssignees === null) {
      return res.status(400).json({ message: "Invalid assignee list" });
    }
    if (targetAssignees.length > 0) {
      const existingCount = await User.countDocuments({ _id: { $in: targetAssignees } });
      if (existingCount !== targetAssignees.length) {
        return res.status(400).json({ message: "One or more assignees were not found" });
      }
    }

    // Departmental / Team Boundary Check for Admins
    if (req.user.role === "admin") {
      const teamUsers = await User.find({ assignedAdmin: req.user._id }).select("_id");
      const allowedIds = teamUsers.map((u) => u._id.toString());
      allowedIds.push(req.user._id.toString()); // Admin can assign to self

      const unauthorized = targetAssignees.some((userId) => !allowedIds.includes(String(userId)));
      if (unauthorized) {
        return res.status(403).json({
          message: "Access denied. You can only assign work to members in your department.",
        });
      }
    }

    const work = new Work({
      title: cleanTitle,
      description: cleanDescription,
      assignedTo: targetAssignees,
      assignedBy: req.user._id,
      deadline: cleanDeadline,
      priority: priority || "Medium",
      driveLink: cleanDriveLink,
    });
    await work.save();

    // Populate the work before returning
    await work.populate("assignedBy assignedTo", "name");

    res.status(201).json(work);

    // Notify assigned users (non-blocking batch insert)
    (async () => {
      try {
        const notifTargets = targetAssignees.filter(
          (userId) => (userId._id || userId).toString() !== req.user.id.toString()
        );

        if (notifTargets.length > 0) {
          const notifications = notifTargets.map((userId) => ({
            title: `Task Assigned: ${work.title}`,
            message: `You have been assigned to task "${work.title}". You have an email for this task allocation.`,
            type: "work",
            sentBy: req.user.id,
            recipients: [userId],
          }));
          await Notification.insertMany(notifications);

          const io = req.app.locals.io;
          if (io) {
            for (const userId of notifTargets) {
              const uIdStr = (userId._id || userId).toString();
              const notifPayload = {
                title: `Task Assigned: ${work.title}`,
                message: `You have been assigned to task "${work.title}". You have an email for this task allocation.`,
                type: "work",
                sentBy: req.user.name,
                createdAt: new Date(),
              };
              io.to(uIdStr).emit("notification", notifPayload);
              io.to(uIdStr).emit("notification:new", notifPayload);
              io.to(uIdStr).emit("notification:update");
              io.to(uIdStr).emit("work:update", { type: "assigned", work });
            }
          }
        }
      } catch (e) {
        console.error("Error creating work notifications:", e);
      }
    })();

    // Send email notifications (non-blocking, HTML-sanitized)
    (async () => {
      try {
        const assignedUsers = await User.find({
          _id: { $in: targetAssignees },
        }).select("name email");
        const appUrl = process.env.APP_URL || "http://localhost:8000";
        const createdDate = new Date().toLocaleString();
        for (const u of assignedUsers) {
          const subject = `New Work Assigned: ${work.title}`;
          const safeTitle = escapeHtml(work.title);
          const safeDesc = escapeHtml(work.description || "-");
          const safeAssigner = escapeHtml(req.user.name);
          const safePriority = escapeHtml(work.priority || "-");
          const html = `
            <p>Hi ${escapeHtml(u.name)},</p>
            <p>You have been <strong>assigned</strong> a new work by <strong>${safeAssigner}</strong>.</p>
            <table>
              <tr><td><strong>Title:</strong></td><td>${safeTitle}</td></tr>
              <tr><td><strong>Description:</strong></td><td>${safeDesc}</td></tr>
              <tr><td><strong>Assigned By:</strong></td><td>${safeAssigner}</td></tr>
              <tr><td><strong>Created:</strong></td><td>${createdDate}</td></tr>
              <tr><td><strong>Deadline:</strong></td><td>${work.deadline ? new Date(work.deadline).toLocaleString() : "-"}</td></tr>
              <tr><td><strong>Priority:</strong></td><td>${safePriority}</td></tr>
            </table>
            <p>Please <a href="${appUrl}">open the Staff Portal</a> and accept it.</p>
            <p>Regards,<br/>Team</p>
          `;
          sendEmail({
            to: u.email,
            subject,
            html,
            text: `${subject} - please log in to Staff Portal to review`,
          }).catch((e) => console.error(e));
        }
      } catch (e) {
        console.error("Error sending work emails:", e);
      }
    })();

    // Emit real-time work update to assigned users, creator, and assigned admin
    try {
      const io = req.app.locals.io;
      if (io) {
        // Notify assigned users
        for (const userId of targetAssignees) {
          io.to(userId.toString()).emit("work:update", {
            type: "created",
            work: work,
          });
        }
        // Notify creator
        io.to(req.user._id.toString()).emit("work:update", {
          type: "created",
          work: work,
        });

        // Also notify assigned admin(s) of any member assigned
        const assignedUserDocs = await User.find({ _id: { $in: targetAssignees } }).select("assignedAdmin");
        for (const u of assignedUserDocs) {
          if (u.assignedAdmin) {
            io.to(u.assignedAdmin.toString()).emit("work:update", {
              type: "created",
              work: work,
            });
          }
        }
      }
    } catch (e) {
      // ignore emit errors
    }
  } catch (err) {
    serverError(res, err, "works");
  }
});

// Update work status (member, admin, superadmin)
router.put("/:id/status", auth, async (req, res) => {
  const { status, note, progress, driveLink } = req.body || {};
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Work not found" });
    if (note !== undefined && note !== null && typeof note !== "string") {
      return res.status(400).json({ message: "Invalid note" });
    }
    if (typeof note === "string" && note.length > LIMITS.note) {
      return res.status(400).json({ message: "Note is too long" });
    }
    let cleanDriveLink;
    if (driveLink !== undefined && driveLink !== null) {
      cleanDriveLink = normalizeUrl(driveLink);
      if (cleanDriveLink === null) {
        return res.status(400).json({ message: "Drive link must be a valid http(s) URL" });
      }
    }
    const work = await Work.findById(req.params.id);
    if (!work) return res.status(404).json({ message: "Work not found" });

    const isAssigned = work.assignedTo.some(
      (id) => (id._id || id).toString() === req.user._id.toString()
    );
    const isAssigner = work.assignedBy.toString() === req.user._id.toString();
    const isSuperAdmin = req.user.role === "superadmin";

    if (!isAssigned && !isAssigner && !isSuperAdmin)
      return res.status(403).json({ message: "Not authorized to update this work" });

    const allowedStatuses = ["assigned", "accepted", "in_progress", "completed", "confirmed"];
    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid work status value" });
    }

    // Only assigner or superadmin can mark work as confirmed (members must use normal completion flow)
    if (status === "confirmed" && !isAssigner && !isSuperAdmin) {
      return res.status(403).json({
        message: "Access denied. Only the creator, assigning admin, or superadmin can confirm completed work.",
      });
    }

    if (status) work.status = status;
    if (cleanDriveLink !== undefined) {
      work.driveLink = cleanDriveLink;
    }
    if (progress !== undefined) {
      const numProgress = Number(progress);
      if (!isNaN(numProgress)) {
        work.progress = Math.min(100, Math.max(0, numProgress));
      }
    }
    if (note)
      work.notes.push({
        user: req.user.id,
        note,
        progress: work.progress,
        date: new Date(),
      });
    await work.save();

    // Notify assigner if completed
    if (status === "completed") {
      const driveInfo = work.driveLink ? ` Work files: ${work.driveLink}` : "";
      const notification = new Notification({
        title: "Work Completed",
        message: `Work "${work.title}" has been completed by ${
          req.user.name || req.user.email || "a team member"
        }.${driveInfo}`,
        type: "work",
        sentBy: req.user.id,
        recipients: [work.assignedBy],
      });
      await notification.save();

      // send email to assigner
      (async () => {
        try {
          const assigner = await User.findById(work.assignedBy).select(
            "name email",
          );
          if (assigner && assigner.email) {
            const subject = `Work Completed: ${work.title}`;
            const safeTitle = escapeHtml(work.title);
            const safeCompletedBy = escapeHtml(req.user.name);
            const driveHtml = work.driveLink
              ? `<p><strong>Deliverables / Drive Link:</strong> <a href="${escapeHtml(work.driveLink)}" target="_blank">${escapeHtml(work.driveLink)}</a></p>`
              : "";
            const html = `
              <p>Hi ${escapeHtml(assigner.name)},</p>
              <p>The work <strong>${safeTitle}</strong> has been <strong>completed</strong> by ${safeCompletedBy}.</p>
              ${driveHtml}
              <p>Regards,<br/>Team</p>
            `;
            sendEmail({ to: assigner.email, subject, html }).catch((e) =>
              console.error(e),
            );
          }
        } catch (e) {
          console.error("Error sending completion email:", e);
        }
      })();
    }

    // Populate the work before returning
    await work.populate("assignedBy assignedTo", "name");

    res.json(work);

    // Emit real-time work update
    try {
      const io = req.app.locals.io;
      if (io) {
        // Notify assigned users
        for (const userId of work.assignedTo) {
          io.to((userId._id || userId).toString()).emit("work:update", {
            type: "updated",
            work: work,
          });
        }
        // Notify admin/superadmin who assigned the work
        io.to(work.assignedBy._id ? work.assignedBy._id.toString() : work.assignedBy.toString()).emit("work:update", {
          type: "updated",
          work: work,
        });
        // Notify user who updated
        io.to(req.user._id.toString()).emit("work:update", {
          type: "updated",
          work: work,
        });
      }
    } catch (e) {
      // ignore emit errors
    }

    // Send progress/note email to assigner if note or progress provided (non-blocking)
    (async () => {
      try {
        if (note !== undefined || progress !== undefined) {
          const assigner = await User.findById(work.assignedBy._id || work.assignedBy).select(
            "name email",
          );
          if (assigner && assigner.email) {
            const subject = `Work Progress: ${work.title} - ${req.user.name}`;
            const safeTitle = escapeHtml(work.title);
            const safeUpdater = escapeHtml(req.user.name);
            const safeNote = escapeHtml(note || "-");
            const html = `
              <p>Hi ${escapeHtml(assigner.name)},</p>
              <p>${safeUpdater} has updated progress on <strong>${safeTitle}</strong>.</p>
              <p><strong>Progress:</strong> ${Number(work.progress) || 0}%</p>
              <p><strong>Note:</strong> ${safeNote}</p>
              <p>Regards,<br/>Team</p>
            `;
            sendEmail({ to: assigner.email, subject, html }).catch((e) =>
              console.error(e),
            );
          }
        }
      } catch (e) {
        console.error("Error sending progress email:", e);
      }
    })();
  } catch (err) {
    serverError(res, err, "works");
  }
});

// Confirm work (admin, superadmin)
router.put("/:id/confirm", auth, roleAuth(["admin", "superadmin"]), async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Work not found" });
    const work = await Work.findById(req.params.id);
    if (!work) return res.status(404).json({ message: "Work not found" });
    if (req.user.role !== "superadmin" && work.assignedBy.toString() !== req.user._id.toString())
      return res.status(403).json({ message: "Not authorized" });

    work.status = "confirmed";
    await work.save();

    // Populate the work before returning
    await work.populate("assignedBy assignedTo", "name");

    res.json(work);

    // Emit real-time work update
    try {
      const io = req.app.locals.io;
      if (io) {
        // Notify assigned users
        for (const userId of work.assignedTo) {
          io.to(userId.toString()).emit("work:update", {
            type: "confirmed",
            work: work,
          });
        }
      }
    } catch (e) {
      // ignore emit errors
    }
  } catch (err) {
    serverError(res, err, "works");
  }
});

// Transfer work to team member(s) (admin, superadmin)
router.put("/:id/transfer", auth, roleAuth(["admin", "superadmin"]), async (req, res) => {
  const { assignedTo, transferNote: rawTransferNote, keepAdminAssigned } = req.body || {};
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: "Work not found" });
    const transferNote = cleanString(rawTransferNote, LIMITS.note);
    if (transferNote === null) return res.status(400).json({ message: "Invalid transfer note" });
    const work = await Work.findById(req.params.id);
    if (!work) return res.status(404).json({ message: "Work not found" });

    const isAssigned = work.assignedTo.some(
      (id) => (id._id || id).toString() === req.user._id.toString()
    );
    const isAssigner = work.assignedBy.toString() === req.user._id.toString();
    const isSuperAdmin = req.user.role === "superadmin";

    let isTeamAdmin = false;
    if (req.user.role === "admin") {
      const teamUsers = await User.find({ assignedAdmin: req.user._id }).select("_id");
      const teamUserIds = teamUsers.map((u) => u._id.toString());
      isTeamAdmin = work.assignedTo.some((id) =>
        teamUserIds.includes((id._id || id).toString())
      );
    }

    if (!isAssigned && !isAssigner && !isSuperAdmin && !isTeamAdmin) {
      return res.status(403).json({ message: "Not authorized to transfer this work" });
    }

    if (!assignedTo || !Array.isArray(assignedTo) || assignedTo.length === 0) {
      return res.status(400).json({ message: "At least one team member must be selected for transfer" });
    }
    const targetIds = idList(assignedTo);
    if (targetIds === null) {
      return res.status(400).json({ message: "Invalid member selection" });
    }

    const targetMembers = await User.find({ _id: { $in: targetIds } }).select("name email role assignedAdmin");
    if (targetMembers.length === 0) {
      return res.status(400).json({ message: "Selected member(s) not found" });
    }

    if (req.user.role === "admin") {
      // Admins may only delegate to members of their own team
      const unauthorized = targetMembers.filter(
        (m) => m.role !== "member" || !m.assignedAdmin || m.assignedAdmin.toString() !== req.user._id.toString()
      );
      if (unauthorized.length > 0) {
        return res.status(403).json({
          message: "You can only transfer work to members in your department",
        });
      }
    }

    let newAssignedIds = targetMembers.map((m) => m._id);
    if (keepAdminAssigned) {
      if (!newAssignedIds.some((id) => id.toString() === req.user._id.toString())) {
        newAssignedIds.push(req.user._id);
      }
    }

    const memberNames = targetMembers.map((m) => m.name).join(", ");
    work.assignedTo = newAssignedIds;
    work.status = "assigned";

    const noteText = transferNote
      ? `[Work Transferred] Delegated to ${memberNames}. Note: ${transferNote}`
      : `[Work Transferred] Delegated to ${memberNames}.`;

    work.notes.push({
      user: req.user._id,
      note: noteText,
      progress: work.progress || 0,
      date: new Date(),
    });

    await work.save();
    await work.populate("assignedBy assignedTo", "name email");

    res.json(work);

    // Create in-app notifications (non-blocking)
    (async () => {
      try {
        const memberNotif = new Notification({
          title: `Task Delegated: ${work.title}`,
          message: `Task "${work.title}" has been delegated to you by ${req.user.name}. You have an email for this task allocation.${transferNote ? ` Note: "${transferNote}"` : ""}`,
          type: "work",
          sentBy: req.user._id,
          recipients: targetMembers.map((m) => m._id),
        });
        await memberNotif.save();

        const assignerIdStr = (work.assignedBy._id || work.assignedBy).toString();
        if (assignerIdStr !== req.user._id.toString()) {
          const assignerNotif = new Notification({
            title: `Work Delegated by Admin`,
            message: `${req.user.name} transferred work "${work.title}" to ${memberNames}.`,
            type: "work",
            sentBy: req.user._id,
            recipients: [work.assignedBy._id || work.assignedBy],
          });
          await assignerNotif.save();
        }
      } catch (e) {
        console.error("Error creating transfer notifications:", e);
      }
    })();

    // Send emails (non-blocking)
    (async () => {
      try {
        for (const m of targetMembers) {
          if (m.email) {
            const subject = `Work Transferred: ${work.title}`;
            const safeTitle = escapeHtml(work.title);
            const safeDesc = escapeHtml(work.description || "-");
            const safeTransferredBy = escapeHtml(req.user.name);
            const safeNote = transferNote ? escapeHtml(transferNote) : "";
            const safePriority = escapeHtml(work.priority || "-");
            const html = `
              <p>Hi ${escapeHtml(m.name)},</p>
              <p>The work <strong>${safeTitle}</strong> has been transferred / delegated to you by <strong>${safeTransferredBy}</strong>.</p>
              <table>
                <tr><td><strong>Title:</strong></td><td>${safeTitle}</td></tr>
                <tr><td><strong>Description:</strong></td><td>${safeDesc}</td></tr>
                <tr><td><strong>Transferred By:</strong></td><td>${safeTransferredBy}</td></tr>
                ${safeNote ? `<tr><td><strong>Note:</strong></td><td>${safeNote}</td></tr>` : ""}
                <tr><td><strong>Deadline:</strong></td><td>${work.deadline ? new Date(work.deadline).toLocaleString() : "-"}</td></tr>
                <tr><td><strong>Priority:</strong></td><td>${safePriority}</td></tr>
              </table>
              <p>Please log in and view your Pending Tasks to accept this work.</p>
              <p>Regards,<br/>Team</p>
            `;
            sendEmail({ to: m.email, subject, html }).catch((e) => console.error(e));
          }
        }
      } catch (e) {
        console.error("Error sending transfer emails:", e);
      }
    })();

    // Real-time Socket Updates
    try {
      const io = req.app.locals.io;
      if (io) {
        const transferPayload = {
          title: `Task Delegated: ${work.title}`,
          message: `Task "${work.title}" has been delegated to you by ${req.user.name}. You have an email for this task allocation.${transferNote ? ` Note: "${transferNote}"` : ""}`,
          type: "work",
          sentBy: req.user.name,
          createdAt: new Date(),
        };

        for (const m of targetMembers) {
          io.to(m._id.toString()).emit("work:update", {
            type: "transferred",
            work,
          });
          io.to(m._id.toString()).emit("notification:new", transferPayload);
          io.to(m._id.toString()).emit("notification:update");
        }
        const assignerIdStr = (work.assignedBy._id || work.assignedBy).toString();
        io.to(assignerIdStr).emit("work:update", {
          type: "transferred",
          work,
        });
        io.to(assignerIdStr).emit("notification:update");

        io.to(req.user._id.toString()).emit("work:update", {
          type: "transferred",
          work,
        });
        io.to(req.user._id.toString()).emit("notification:update");
      }
    } catch (e) {
      // ignore emit errors
    }

  } catch (err) {
    serverError(res, err, "works");
  }
});

module.exports = router;
