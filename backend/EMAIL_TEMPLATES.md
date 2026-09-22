# Email Templates & Subjects

This document outlines the email subjects and the high-level structure used by the system.

1. New Work Assigned ✅
   - Subject: "New Work Assigned: <Work Title>"
   - To: assigned user(s)
   - Content: formal greeting, work details (title, description, assigned by, created date, deadline, priority), link to view/accept the work, closing.

2. Work Progress / Update 📈
   - Subject: "Work Progress: <Work Title> - <Member Name>"
   - To: assigner (admin who created the work)
   - Content: who updated, progress percentage, optional note, link to work details, closing.

3. Work Completed ✅
   - Subject: "Work Completed: <Work Title>"
   - To: assigner
   - Content: who completed it, title & link, closing.

4. Meeting Scheduled 📅
   - Subject: "Meeting Scheduled: <Meeting Title>"
   - To: participants
   - Content: who scheduled, title, description, date, time, link/location, participants list, link to meeting in app, closing.

5. Leave Request ✉️
   - Subject: "Leave Request: <Requester Name>"
   - To: assigned admin or superadmin (for admin requests)
   - Content: dates, reason, requester's name, review/approval instruction, closing.

6. Leave Request Update (Approved/Rejected) ✔️/❌
   - Subject: "Leave Request Approved" or "Leave Request Rejected"
   - To: requester
   - Content: status update, dates, rejection reason (if any), closing.

Notes:

- The app uses `process.env.APP_URL` for constructing links (defaults to `http://localhost:3000`).
- Email sending is done asynchronously and errors are logged but do not block API responses.
