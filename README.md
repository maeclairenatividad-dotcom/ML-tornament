# ML Tournament Registration System

A full-stack tournament registration system built with:
- Frontend: plain HTML, CSS, JavaScript
- Backend: Node.js + Express
- Database: SQLite locally (zero setup) or Postgres/Neon in production — picked automatically from `DATABASE_URL`
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
├── render.yaml        (Render Blueprint)
├── server.js
├── README.md
└── database.sqlite   (created on first run when DATABASE_URL is not set)

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
   - `DATABASE_URL`: optional. Leave empty to use the local SQLite file; set it to a Postgres connection
     string to run against Neon or another Postgres server.
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

### Option A: Render + Neon (recommended for the free tier)

Render's free web instances have an ephemeral filesystem, so use Neon (free serverless Postgres) for the database. No Render disk is needed.

1. **Create the database (Neon)**
   - Sign up at https://neon.tech and create a project (pick the region closest to your Render region).
   - Copy the **pooled** connection string. It looks like
     `postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`.
   - Tables are created automatically on first start; nothing else to run.
2. **Deploy the app (Render)**
   - Push this repository to GitHub.
   - In Render: **New > Blueprint**, pick the repository, and apply `render.yaml`.
     (Or create a Web Service manually: build `npm install`, start `npm start`, health check `/api/health`.)
3. **Set the environment variables** in the Render dashboard (the Blueprint marks secret ones as "sync: false"):
   - `DATABASE_URL`: the Neon pooled connection string
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`: the admin account created on first boot
   - `BREVO_API_KEY`, `MAIL_FROM_EMAIL` (optional — can also be entered in the admin Settings tab)
   - `JWT_SECRET` is generated by the Blueprint; keep it stable (changing it logs everyone out)
4. Wait for the deploy to go live, then open `https://<your-service>.onrender.com/api/health` and log in as admin.

Free-tier notes:
- The Render service sleeps after ~15 minutes without traffic; the first request afterwards takes ~30–60 seconds.
- Neon's free compute also auto-suspends; the first query after idling may take a second or two.
- Both free plans are enough for a school tournament. Upgrade only if you need always-on uptime.

### Option B: any Node host with SQLite

1. Build command `npm install`, start command `npm start`.
2. Set `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, and optionally `BREVO_API_KEY` / `MAIL_FROM_EMAIL`.
3. Attach a persistent disk and set `DB_PATH` to a file on it (e.g. `/data/database.sqlite`), otherwise data is wiped on redeploy.

### Switching databases
The app chooses the database from `DATABASE_URL`:
- Set → Postgres (tables created automatically, SSL enabled unless the URL contains `sslmode=disable`).
- Empty → local SQLite file (`DB_PATH`, default `./database.sqlite`).

Data is not migrated between the two; pick one before going live.

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
- The in-memory rate limiter resets whenever the server restarts and is per-instance; use a shared store if you scale beyond one instance.
