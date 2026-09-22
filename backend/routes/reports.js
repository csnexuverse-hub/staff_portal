const express = require("express");
const Work = require("../models/Work");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const ExcelJS = require("exceljs");
const { auth, roleAuth } = require("../middleware/auth");
const { sanitizeFormula } = require("../utils/sanitize");
const { serverError } = require("../utils/errors");
const { isObjectId, isValidDate } = require("../utils/validate");

// Rejects anything other than "all" or a valid ObjectId in :userId
function validUserParam(req, res, next) {
  const { userId } = req.params;
  if (userId !== "all" && !isObjectId(userId)) {
    return res.status(400).json({ message: "Invalid user id" });
  }
  next();
}

// Builds a safe date filter from query params (only plain strings accepted)
function buildDateFilter(query) {
  const { startDate, endDate } = query || {};
  const filter = {};
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) {
      if (typeof startDate !== "string" || !isValidDate(startDate)) return null;
      filter.date.$gte = new Date(startDate);
    }
    if (endDate) {
      if (typeof endDate !== "string" || !isValidDate(endDate)) return null;
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.date.$lte = end;
    }
  }
  return filter;
}

const router = express.Router();

// Helper: get team user IDs for admin
async function getAdminTeamUserIds(adminUser) {
  const adminId = adminUser._id || adminUser.id;
  const query = {
    $or: [
      { assignedAdmin: adminId },
      { assignedAdmin: adminId.toString() },
    ],
  };
  if (adminUser.department) {
    query.$or.push({ department: adminUser.department, role: "member" });
  }
  const members = await User.find(query).select("_id");
  const ids = members.map((m) => m._id.toString());
  ids.push(adminId.toString());
  return ids;
}

// Get work report data
router.get(
  "/work/:userId",
  auth,
  roleAuth(["admin", "superadmin"]),
  validUserParam,
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (userId !== "all" && req.user.role === "admin") {
        const teamUserIds = await getAdminTeamUserIds(req.user);
        if (!teamUserIds.includes(userId)) {
          return res.status(403).json({
            message: "Access denied. You can only view work reports for your team.",
          });
        }
      }

      let works;
      if (userId === "all") {
        if (req.user.role === "superadmin") {
          works = await Work.find().populate("assignedBy assignedTo", "name email role");
        } else {
          const userIds = await getAdminTeamUserIds(req.user);
          works = await Work.find({
            $or: [
              { assignedTo: { $in: userIds } },
              { assignedBy: req.user._id },
            ],
          }).populate("assignedBy assignedTo", "name email role");
        }
      } else {
        works = await Work.find({ assignedTo: userId }).populate(
          "assignedBy assignedTo",
          "name email role"
        );
      }
      res.json(works);
    } catch (err) {
      serverError(res, err, "reports");
    }
  }
);

// Get attendance report data
router.get(
  "/attendance/:userId",
  auth,
  roleAuth(["admin", "superadmin"]),
  validUserParam,
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (userId !== "all" && req.user.role === "admin") {
        const teamUserIds = await getAdminTeamUserIds(req.user);
        if (!teamUserIds.includes(userId)) {
          return res.status(403).json({
            message: "Access denied. You can only view attendance reports for your team.",
          });
        }
      }

      const dateFilter = buildDateFilter(req.query);
      if (dateFilter === null) {
        return res.status(400).json({ message: "Invalid date range" });
      }

      let attendances;
      if (userId === "all") {
        if (req.user.role === "superadmin") {
          attendances = await Attendance.find(dateFilter).populate(
            "user",
            "name email role department"
          );
        } else {
          const userIds = await getAdminTeamUserIds(req.user);
          attendances = await Attendance.find({
            user: { $in: userIds },
            ...dateFilter,
          }).populate("user", "name email role department");
        }
      } else {
        attendances = await Attendance.find({
          user: userId,
          ...dateFilter,
        }).populate("user", "name email role department");
      }
      res.json(attendances);
    } catch (err) {
      serverError(res, err, "reports");
    }
  }
);

// Download work report (Excel)
router.get(
  "/work/download/:userId",
  auth,
  roleAuth(["admin", "superadmin"]),
  validUserParam,
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (userId !== "all" && req.user.role === "admin") {
        const teamUserIds = await getAdminTeamUserIds(req.user);
        if (!teamUserIds.includes(userId)) {
          return res.status(403).json({
            message: "Access denied. You can only download work reports for your team.",
          });
        }
      }

      let works;
      let reportTargetName = "all_team";

      if (userId === "all") {
        reportTargetName = req.user.role === "superadmin" ? "all_organization" : "all_team";
        if (req.user.role === "superadmin") {
          works = await Work.find().populate("assignedBy assignedTo", "name email role department");
        } else {
          const userIds = await getAdminTeamUserIds(req.user);
          works = await Work.find({
            $or: [
              { assignedTo: { $in: userIds } },
              { assignedBy: req.user._id },
            ],
          }).populate("assignedBy assignedTo", "name email role department");
        }
      } else {
        const targetUser = await User.findById(userId);
        if (targetUser && targetUser.name) {
          reportTargetName = targetUser.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
        }
        works = await Work.find({ assignedTo: userId }).populate(
          "assignedBy assignedTo",
          "name email role department"
        );
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Work Report");

      worksheet.columns = [
        { header: "Title", key: "title", width: 30 },
        { header: "Description", key: "description", width: 35 },
        { header: "Assigned To", key: "assignedTo", width: 25 },
        { header: "Assigned By", key: "assignedBy", width: 20 },
        { header: "Status", key: "status", width: 15 },
        { header: "Priority", key: "priority", width: 12 },
        { header: "Progress (%)", key: "progress", width: 15 },
        { header: "Drive Link", key: "driveLink", width: 35 },
        { header: "Created Date", key: "createdAt", width: 18 },
        { header: "Deadline", key: "deadline", width: 18 },
      ];

      works.forEach((work) => {
        const rawAssignedTo = work.assignedTo?.map((u) => u.name || u).join(", ") || "Unassigned";
        worksheet.addRow({
          title: sanitizeFormula(work.title),
          description: sanitizeFormula(work.description || "-"),
          assignedTo: sanitizeFormula(rawAssignedTo),
          assignedBy: sanitizeFormula(work.assignedBy?.name || "Unknown"),
          status: sanitizeFormula(work.status),
          priority: sanitizeFormula(work.priority || "Medium"),
          progress: `${work.progress || 0}%`,
          driveLink: sanitizeFormula(work.driveLink || "-"),
          createdAt: work.createdAt ? new Date(work.createdAt).toLocaleDateString() : "-",
          deadline: work.deadline ? new Date(work.deadline).toLocaleDateString() : "No deadline",
        });
      });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=work_report_${reportTargetName}_${new Date().toISOString().split("T")[0]}.xlsx`
      );

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      serverError(res, err, "reports");
    }
  }
);

// Download attendance report (Excel)
router.get(
  "/attendance/download/:userId",
  auth,
  roleAuth(["admin", "superadmin"]),
  validUserParam,
  async (req, res) => {
    try {
      const { userId } = req.params;

      if (userId !== "all" && req.user.role === "admin") {
        const teamUserIds = await getAdminTeamUserIds(req.user);
        if (!teamUserIds.includes(userId)) {
          return res.status(403).json({
            message: "Access denied. You can only download attendance reports for your team.",
          });
        }
      }

      const dateFilter = buildDateFilter(req.query);
      if (dateFilter === null) {
        return res.status(400).json({ message: "Invalid date range" });
      }

      let attendances;
      let reportTargetName = "all_users";

      if (userId === "all") {
        reportTargetName = req.user.role === "superadmin" ? "all_organization" : "all_team";
        if (req.user.role === "superadmin") {
          attendances = await Attendance.find(dateFilter).populate(
            "user",
            "name email role department"
          );
        } else {
          const userIds = await getAdminTeamUserIds(req.user);
          attendances = await Attendance.find({
            user: { $in: userIds },
            ...dateFilter,
          }).populate("user", "name email role department");
        }
      } else {
        const targetUser = await User.findById(userId);
        if (targetUser && targetUser.name) {
          reportTargetName = targetUser.name.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
        }
        attendances = await Attendance.find({
          user: userId,
          ...dateFilter,
        }).populate("user", "name email role department");
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Attendance Report");

      worksheet.columns = [
        { header: "Employee Name", key: "name", width: 25 },
        { header: "Role", key: "role", width: 15 },
        { header: "Department", key: "department", width: 20 },
        { header: "Date", key: "date", width: 15 },
        { header: "Check In", key: "checkIn", width: 15 },
        { header: "Check Out", key: "checkOut", width: 15 },
        { header: "Status", key: "status", width: 15 },
        { header: "Duration", key: "duration", width: 18 },
      ];

      attendances.forEach((att) => {
        const checkIn = att.checkIn ? new Date(att.checkIn) : null;
        const checkOut = att.checkOut ? new Date(att.checkOut) : null;
        let duration = "-";
        if (checkIn && checkOut) {
          duration = `${(Math.round(((checkOut - checkIn) / (1000 * 60 * 60)) * 100) / 100).toFixed(2)} hrs`;
        } else if (checkIn) {
          duration = "In progress";
        }

        worksheet.addRow({
          name: sanitizeFormula(att.user?.name || "Unknown"),
          role: sanitizeFormula(att.user?.role || "-"),
          department: sanitizeFormula(att.user?.department || "-"),
          date: att.date ? new Date(att.date).toLocaleDateString() : (checkIn ? checkIn.toLocaleDateString() : "-"),
          checkIn: checkIn ? checkIn.toLocaleTimeString() : "-",
          checkOut: checkOut ? checkOut.toLocaleTimeString() : "Not checked out",
          status: sanitizeFormula(att.status || (checkOut ? "present" : "in progress")),
          duration,
        });
      });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=attendance_report_${reportTargetName}_${new Date().toISOString().split("T")[0]}.xlsx`
      );

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      serverError(res, err, "reports");
    }
  }
);

module.exports = router;
