# ML Tournament Registration System

A full-stack tournament registration system built with:
- Frontend: plain HTML, CSS, JavaScript
- Backend: Node.js + Express
- Database: SQLite (better-sqlite3)
- Notifications: Brevo API (configured in the admin Settings tab) with Gmail SMTP as an `.env` fallback
- Certificates: PDF generation with PDFKit

## Features
- User registration and login with email and password
- Profile data: Full Name, School ID, Program, Email, IGN
- Team registration (captain + 4 players, optional substitute)
- View tournament schedules with date, time and venue
- Admin-only access (separate admin login, role checked on every admin API route)
- Admin creates tournaments and schedules (date, time, location)
- Admin approves or rejects team registrations
- Admin creates the bracket (4 to 8 approved teams, BYEs supported) and enters match scores; winners advance automatically
- Admin emails qualified teams
- Certificates (PDF) are generated and emailed automatically when the final is scored, and can be resent manually

## Project Structure
text
ml-tournament-registration-system/
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── .env
├── .env.example
├── .gitignore
├── db.js
├── package.json
├── server.js
├── README.md
└── database.sqlite   (created on first run)

## Setup
1. Install Node.js 18 or newer.
2. npm install
3. Edit .env:
   - JWT_SECRET: any long random string
   - ADMIN_EMAIL / ADMIN_PASSWORD: the admin account (created automatically on first start). Change the default password.
   - GMAIL_USER / GMAIL_APP_PASSWORD: optional fallback, a Gmail address and a Google App Password
     (Google Account > Security > 2-Step Verification > App passwords).
   Brevo is configured in the app: log in as admin and open Settings, then paste your Brevo API key
   (Brevo > SMTP & API > API Keys) and set the sender email/name. The sender must be verified in Brevo.
   Without either option, the app still works but emails are skipped.
4. npm start, then open http://localhost:3000

## How to use
*Players:* Register > Login > Register Team > wait for approval > check Schedule, Bracket and Notifications.

*Admin (Admin tab on the login page):*
1. Tournaments & Schedule: create a tournament, then add schedules (date, time, venue).
2. Team Approvals: approve or reject teams.
3. Bracket: pick seeds from approved teams and create the bracket. Click a match to enter its score.
4. Notify & Certificates: email qualified teams. Certificates go out automatically after match 13 is scored.
5. Settings: paste your Brevo API key, set the sender email/name, and send yourself a test email.

## Bracket layout
Matches follow the numbering in the sample image:
- Round 1: 7 = seed 1 vs 8, 8 = seed 4 vs 5, 9 = seed 2 vs 7, 10 = seed 3 vs 6
- Semifinals: 11 = winner 7 vs winner 8, 12 = winner 9 vs winner 10
- Final: 13

## API summary
| Method | Route | Access |
|---|---|---|
| POST | /api/auth/register, /api/auth/login | public |
| GET | /api/me, /api/tournaments, /api/schedules, /api/tournaments/:id/bracket, /api/notifications | logged in |
| GET | /api/health | public |
| POST | /api/teams | player |
| GET | /api/teams/mine | player |
| POST | /api/admin/tournaments, /api/admin/schedules | admin |
| PUT | /api/admin/teams/:id/status | admin |
| POST | /api/admin/tournaments/:id/bracket | admin |
| PUT | /api/admin/matches/:id | admin |
| POST | /api/admin/tournaments/:id/notify-qualified, /send-certificates | admin |
| GET/PUT | /api/admin/mail-settings, POST /api/admin/mail-settings/test | admin |

## Deploying
1. Push the project to a Git repository and create a Node web service on your host.
2. Build command: `npm install`. Start command: `npm start`.
3. Set these environment variables on the host (copy from `.env.example`):
   - `JWT_SECRET` (32+ random characters, required in production)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`
   - `BREVO_API_KEY`, `MAIL_FROM_EMAIL` (or configure Brevo in the admin Settings tab)
4. Health check path: `/api/health`.

### SQLite persistence
The app stores data in SQLite. On hosts with an ephemeral filesystem (e.g. a free tier), the database
is wiped on every deploy or restart. Attach a persistent disk and set `DB_PATH` to a file on it, e.g.
`DB_PATH=/data/database.sqlite`. Make sure the mounted directory is writable.

### Email on hosted platforms
Brevo sends over the HTTPS API, so it works even where outbound SMTP ports are blocked (Render blocks
ports 25/465/587 on free instances). Gmail SMTP remains only as a fallback.

### Before going live
- Never commit `.env`; it is gitignored. Set secrets in the host dashboard.
- Use a long, random `JWT_SECRET`; changing it logs everyone out.
- Rotate the admin password if it was ever shared in plain text.
- The host provides HTTPS; the app does not terminate TLS itself.
- Login and registration are rate-limited to 100 requests per IP per 15 minutes.

## Notes
- Emails are not verified at sign-up; add an email confirmation step before production use.
- Add rate limiting (e.g. express-rate-limit) and HTTPS before deploying publicly.
