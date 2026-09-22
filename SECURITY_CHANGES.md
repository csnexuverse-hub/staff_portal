# Security changes

## Critical
| Issue | Fix | Where |
|---|---|---|
| Stored XSS (~130 unescaped values rendered with `innerHTML`) – any user could run script in an admin's browser and steal their session | Every server value is now passed through `escapeHtml()`; every link through `safeUrl()` (http/https only); inline `onclick` arguments are JSON-encoded | `frontend/index.html` |
| Weak JWT secret committed in `.env` | `.env` removed, `.gitignore` added, server refuses to start with a secret < 32 chars, tokens pinned to HS256 | `backend/index.js`, `utils/tokens.js` |
| Open registration = instant access to staff directory | New accounts are *pending* until a superadmin approves them; optional domain allow-list; registration can be disabled; bootstrap superadmin via env var | `routes/auth.js`, `routes/users.js`, UI "Approve" button |

## High
| Issue | Fix |
|---|---|
| Members could send spoofed notifications to anyone | `POST /api/notifications` limited to admin/superadmin; recipients validated |
| Meeting / Drive links accepted `javascript:` | Server accepts only http(s) URLs (bare hosts get `https://`) |
| Rate limiting broken behind Render's proxy | `trust proxy` set; limits per logged-in user, failed logins per IP, email-sending actions limited |

## Medium
- Email/password change requires the current password; password change or admin reset **logs out all other sessions** (token version). The user who changes their own password gets a fresh token automatically.
- Admins can no longer approve another admin's / superadmin's leave.
- Admins can only assign/transfer work to their own team's members.
- No internal error messages or stack traces are sent to clients; unknown API routes return JSON 404; request bodies capped at 100 KB.
- Content-Security-Policy enabled: the page can only talk to its own server, cannot be framed, no plugins.
- Password hashes can never be serialised (schema-level guard); leave approval no longer returns the requester's full user document.

## Low / hardening
- Strict type & length validation on every input (blocks `{ "$gt": "" }` style NoSQL injection).
- Minimum password length 8, bcrypt cost 12, constant-time login response.
- Leave requests from members without an admin go to superadmins instead of being broadcast to all staff.
- AI-tool seat claim is atomic (no over-booking).
- Email subjects stripped of line breaks (no header injection); `SMTP_URL` now actually works.
- Socket.IO: token only from the auth payload, user re-checked in the DB, users can only join their own room, auto-rejoin after reconnect.
- `/api/health` endpoint for Render health checks.

## Pre-existing bugs fixed along the way
- Dashboard stayed empty after logging in until the page was refreshed.
- Logging out kept the previous user's data in memory (visible to the next person on the same browser until refresh).
- Profile page could not be saved right after login because the mobile field was empty.
- Confirming a deleted work item crashed the request.

## Known, unchanged
- The **AI Tools** page talks to endpoints/fields the backend does not have (`/api/aiToolUsages`, `toolName` vs `name`) – this was already the case and was left as is.
- Styling uses the Tailwind Play CDN (needs `'unsafe-eval'` in the CSP). For stricter CSP, build Tailwind to a static CSS file and remove `'unsafe-eval'` in `backend/index.js`.
- Attendance "today" uses the UTC date (frontend and backend agree, so it is consistent).
