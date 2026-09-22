# CS Development Technologies – Staff Portal

Node/Express + MongoDB backend that also serves the single-page frontend.
One Render **Web Service** runs everything (API, website and real-time updates).

```
final/
├── backend/            Express API, Socket.IO, MongoDB models
│   ├── .env.example    template for local settings (never commit a real .env)
│   └── index.js        entry point – also serves ../frontend
├── frontend/
│   ├── index.html      the whole UI
│   └── socket.io.min.js
├── render.yaml         optional Render Blueprint
└── SECURITY_CHANGES.md what was fixed and why
```

## Run locally

```bash
cd backend
cp .env.example .env        # then fill in JWT_SECRET, MONGO_URI, BOOTSTRAP_SUPERADMIN_EMAIL
npm install
npm start                   # http://localhost:5000  (serves the UI too)
```

(The old two-terminal setup – `python -m http.server 8000` in `frontend/` plus the
backend on port 5000 – still works for development.)

If port 5000 is busy on Windows: `Get-NetTCPConnection -LocalPort 5000 | Select-Object OwningProcess`
then `Stop-Process -Id <PID> -Force`.

## First login

1. Set `BOOTSTRAP_SUPERADMIN_EMAIL` to your email.
2. Open the site → **Register** with exactly that email. That account becomes the superadmin automatically
   (this only works while no superadmin exists).
3. Everyone else registers normally and appears in **User & Role Management** with a *Pending approval*
   badge. Click **Approve**, then **Edit** to set role/department/admin.

## Deploy on Render

See the step-by-step guide in the chat, or in short:

| Setting | Value |
|---|---|
| Service type | Web Service (Node) |
| Root Directory | *(blank)* |
| Build Command | `cd backend && npm ci --omit=dev` |
| Start Command | `node backend/index.js` |
| Health Check Path | `/api/health` |

Required environment variables: `NODE_ENV=production`, `JWT_SECRET`, `MONGO_URI`, `APP_URL`,
`BOOTSTRAP_SUPERADMIN_EMAIL`. Optional: `REQUIRE_APPROVAL`, `REGISTRATION_ENABLED`,
`ALLOWED_EMAIL_DOMAINS`, `EMAIL_*`. All are documented in `backend/.env.example`.
