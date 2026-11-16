require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { db, seedAdmin } = require('./db');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  if (IS_PROD) {
    console.error('FATAL: JWT_SECRET is required in production.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET is not set. Set it in .env.');
} else if (IS_PROD && JWT_SECRET.length < 32) {
  console.warn('WARNING: JWT_SECRET is short. Use at least 32 random characters in production.');
}

seedAdmin();

const app = express();
app.disable('x-powered-by');
if (IS_PROD) app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Small in-memory limiter so login/register cannot be brute-forced.
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now >= entry.reset) {
      hits.set(req.ip, { count: 1, reset: now + windowMs });
      if (hits.size > 10000) for (const [ip, e] of hits) if (now >= e.reset) hits.delete(ip);
      return next();
    }
    if (++entry.count > max) return res.status(429).json({ error: message });
    next();
  };
}
app.use(
  '/api/auth',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many attempts. Please wait a few minutes and try again.',
  })
);

/* ======================================================================
   EMAIL (Brevo API, with Gmail SMTP fallback from .env)
   Brevo details are entered in the admin Settings tab and stored in the
   database, so no redeploy is needed to change them.
   ====================================================================== */
const SETTING_KEYS = {
  apiKey: 'mail.brevo_api_key',
  fromEmail: 'mail.from_email',
  fromName: 'mail.from_name',
};

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';

function setSetting(key, value) {
  if (value === null || value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
}

function mailConfig() {
  const apiKey = getSetting(SETTING_KEYS.apiKey) || process.env.BREVO_API_KEY || '';
  const fromName = getSetting(SETTING_KEYS.fromName) || process.env.MAIL_FROM_NAME || 'ML Tournament';
  const fromEmail = getSetting(SETTING_KEYS.fromEmail) || process.env.MAIL_FROM_EMAIL || process.env.GMAIL_USER || '';
  if (apiKey && fromEmail) return { provider: 'brevo', apiKey, fromEmail, fromName };
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
    return {
      provider: 'gmail',
      fromEmail: process.env.GMAIL_USER,
      fromName,
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    };
  return { provider: 'none', fromEmail, fromName };
}

let gmailTransport = null;

function deliverMail(cfg, { to, subject, text, attachments = [] }) {
  if (cfg.provider === 'brevo') return sendViaBrevo(cfg, { to, subject, text, attachments });
  if (!gmailTransport)
    gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.user, pass: cfg.pass },
    });
  return gmailTransport.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
    to,
    subject,
    text,
    attachments,
  });
}

async function sendViaBrevo(cfg, { to, subject, text, attachments = [] }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.apiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: cfg.fromEmail, name: cfg.fromName },
      to: [{ email: to }],
      subject,
      textContent: text,
      attachment: attachments.map((a) => ({
        name: a.filename,
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content),
      })),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.message || `Brevo rejected the request (HTTP ${res.status}). Check the API key and sender email.`
    );
  }
}

async function sendMail(to, subject, text, attachments = []) {
  const cfg = mailConfig();
  if (cfg.provider === 'none') {
    console.log(`[MAIL NOT CONFIGURED] would send to ${to}: ${subject}`);
    return false;
  }
  try {
    await deliverMail(cfg, { to, subject, text, attachments });
    return true;
  } catch (err) {
    console.error(`Mail to ${to} failed:`, err.message);
    return false;
  }
}

function mailStatus() {
  const cfg = mailConfig();
  const storedKey = getSetting(SETTING_KEYS.apiKey);
  const envKey = process.env.BREVO_API_KEY || '';
  const apiKey = storedKey || envKey;
  return {
    configured: cfg.provider !== 'none',
    provider: cfg.provider,
    fromEmail: cfg.fromEmail,
    fromName: cfg.fromName,
    hasKey: !!storedKey,
    keySource: storedKey ? 'database' : envKey ? 'environment' : '',
    keyHint: apiKey ? `...${apiKey.slice(-4)}` : '',
  };
}

// Saves an in-app notification and (optionally) emails it.
async function notify(userId, subject, message, { email = null, attachments = [] } = {}) {
  const info = db
    .prepare('INSERT INTO notifications (user_id, subject, message) VALUES (?, ?, ?)')
    .run(userId, subject, message);
  if (!email) return false;
  const ok = await sendMail(email, subject, message, attachments);
  db.prepare('UPDATE notifications SET emailed = ? WHERE id = ?').run(ok ? 1 : 0, info.lastInsertRowid);
  return ok;
}

/* ======================================================================
   CERTIFICATE (PDF)
   ====================================================================== */
function buildCertificate({ recipient, ign, teamName, tournamentName, dateText }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    doc.rect(20, 20, W - 40, H - 40).lineWidth(5).stroke('#f59e0b');
    doc.rect(34, 34, W - 68, H - 68).lineWidth(1).stroke('#1f2937');

    doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(38)
      .text('CERTIFICATE OF ACHIEVEMENT', 0, 90, { align: 'center', width: W });
    doc.fillColor('#6b7280').font('Helvetica').fontSize(16)
      .text('This certificate is proudly presented to', 0, 160, { align: 'center', width: W });
    doc.fillColor('#2e1cf4').font('Helvetica-Bold').fontSize(34)
      .text(recipient, 0, 195, { align: 'center', width: W });
    doc.fillColor('#6b7280').font('Helvetica').fontSize(15)
      .text(`"${ign}"  |  Team ${teamName}`, 0, 245, { align: 'center', width: W });
    doc.fillColor('#1f2937').font('Helvetica').fontSize(18)
      .text('for winning', 0, 290, { align: 'center', width: W });
    doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(26)
      .text(`CHAMPION - ${tournamentName}`, 60, 320, { align: 'center', width: W - 120 });
    doc.fillColor('#6b7280').font('Helvetica').fontSize(13)
      .text(`Awarded on ${dateText}`, 0, 430, { align: 'center', width: W });

    doc.moveTo(W / 2 - 110, 485).lineTo(W / 2 + 110, 485).lineWidth(1).stroke('#1f2937');
    doc.fillColor('#1f2937').fontSize(12).text('Tournament Director', 0, 492, { align: 'center', width: W });
    doc.end();
  });
}

// Builds a certificate for every member of the champion team and emails them.
async function sendCertificates(tournamentId) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!t) throw new Error('Tournament not found');
  if (!t.champion_team_id) throw new Error('No champion yet. Score the final match (13) first.');

  const team = db
    .prepare(
      `SELECT tm.*, u.full_name AS cap_name, u.email AS cap_email, u.ign AS cap_ign
       FROM teams tm JOIN users u ON u.id = tm.captain_id WHERE tm.id = ?`
    )
    .get(t.champion_team_id);

  const members = [
    { name: team.cap_name, ign: team.cap_ign, email: team.cap_email },
    ...JSON.parse(team.members || '[]'),
  ];
  const dateText = new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });

  const certs = [];
  for (const m of members) {
    const pdf = await buildCertificate({
      recipient: m.name, ign: m.ign, teamName: team.name, tournamentName: t.name, dateText,
    });
    certs.push({
      member: m,
      attachment: { filename: `Certificate-${m.name.replace(/[^a-z0-9]+/gi, '_')}.pdf`, content: pdf },
    });
  }

  const subject = `Congratulations, ${team.name}! Your ${t.name} certificates`;
  const body =
    `Congratulations to team ${team.name} for winning ${t.name}!\n\n` +
    `Your certificate(s) of achievement are attached as PDF files.`;

  // Captain receives every member's certificate.
  let allOk = await notify(team.captain_id, subject, body, {
    email: team.cap_email,
    attachments: certs.map((c) => c.attachment),
  });

  // Members who gave an email receive their own certificate.
  let sent = 1;
  for (const c of certs.slice(1)) {
    const email = (c.member.email || '').toLowerCase();
    if (!email || email === team.cap_email.toLowerCase()) continue;
    const ok = await sendMail(email, subject, body, [c.attachment]);
    allOk = allOk && ok;
    sent++;
  }

  db.prepare('UPDATE tournaments SET certificates_sent = 1 WHERE id = ?').run(tournamentId);
  return {
    team: team.name,
    certificates: certs.length,
    emailsAttempted: sent,
    allEmailed: allOk,
    mailConfigured: mailStatus().configured,
  };
}

/* ======================================================================
   AUTH MIDDLEWARE
   ====================================================================== */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare('SELECT id, full_name, school_id, program, email, ign, role FROM users WHERE id = ?')
      .get(payload.id);
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only.' });
  next();
}
const admin = [auth, adminOnly];
const signToken = (user) => jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '12h' });

/* ======================================================================
   AUTH ROUTES
   ====================================================================== */
app.post('/api/auth/register', (req, res) => {
  const { fullName, schoolId, program, email, ign, password } = req.body || {};
  if (![fullName, schoolId, program, email, ign, password].every((v) => typeof v === 'string' && v.trim()))
    return res.status(400).json({ error: 'All fields are required.' });
  if (!EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    const info = db
      .prepare(
        `INSERT INTO users (full_name, school_id, program, email, ign, password_hash, role)
         VALUES (?, ?, ?, ?, ?, ?, 'user')`
      )
      .run(fullName.trim(), schoolId.trim(), program.trim(), email.trim(), ign.trim(), bcrypt.hashSync(password, 10));
    const user = db
      .prepare('SELECT id, full_name, school_id, program, email, ign, role FROM users WHERE id = ?')
      .get(info.lastInsertRowid);
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT'))
      return res.status(409).json({ error: 'That email is already registered.' });
    throw err;
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password, adminLogin } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  if (adminLogin && row.role !== 'admin') return res.status(403).json({ error: 'This account is not an admin.' });
  if (!adminLogin && row.role === 'admin') return res.status(403).json({ error: 'Admins must use the Admin Login tab.' });
  const { password_hash, ...user } = row;
  res.json({ token: signToken(user), user });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

/* ======================================================================
   TOURNAMENTS, SCHEDULES, BRACKET (readable by any logged-in user)
   ====================================================================== */
app.get('/api/tournaments', auth, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT t.*,
           (SELECT COUNT(*) FROM teams WHERE tournament_id = t.id) AS team_count,
           (SELECT name FROM teams WHERE id = t.champion_team_id) AS champion
         FROM tournaments t ORDER BY t.id DESC`
      )
      .all()
  );
});

app.get('/api/schedules', auth, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT s.*, t.name AS tournament_name FROM schedules s
         JOIN tournaments t ON t.id = s.tournament_id
         ORDER BY s.match_date, s.match_time`
      )
      .all()
  );
});

function getBracket(tid) {
  return db
    .prepare(
      `SELECT m.*, t1.name AS team1_name, t1.seed AS seed1, t2.name AS team2_name, t2.seed AS seed2
       FROM matches m
       LEFT JOIN teams t1 ON t1.id = m.team1_id
       LEFT JOIN teams t2 ON t2.id = m.team2_id
       WHERE m.tournament_id = ? ORDER BY m.label`
    )
    .all(tid);
}
app.get('/api/tournaments/:id/bracket', auth, (req, res) => res.json(getBracket(+req.params.id)));

/* ======================================================================
   USER: TEAM REGISTRATION & NOTIFICATIONS
   ====================================================================== */
app.post('/api/teams', auth, (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ error: 'Admins cannot register teams.' });
  const { tournamentId, name, members } = req.body || {};
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(+tournamentId);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });
  if (t.status !== 'registration') return res.status(400).json({ error: 'Registration for this tournament is closed.' });
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Team name is required.' });

  const cleaned = (Array.isArray(members) ? members : [])
    .map((m) => ({
      name: String(m?.name || '').trim(),
      ign: String(m?.ign || '').trim(),
      email: String(m?.email || '').trim(),
    }))
    .filter((m) => m.name || m.ign || m.email);
  if (cleaned.length < 4 || cleaned.length > 5)
    return res.status(400).json({ error: 'Add 4 more players (a 5th substitute is optional). You are the captain.' });
  for (const m of cleaned) {
    if (!m.name || !m.ign) return res.status(400).json({ error: 'Each player needs a full name and IGN.' });
    if (m.email && !EMAIL_RE.test(m.email)) return res.status(400).json({ error: `Invalid email for ${m.name}.` });
  }

  try {
    const info = db
      .prepare('INSERT INTO teams (tournament_id, captain_id, name, members) VALUES (?, ?, ?, ?)')
      .run(t.id, req.user.id, name.trim(), JSON.stringify(cleaned));
    res.status(201).json({ id: info.lastInsertRowid, status: 'pending' });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT'))
      return res.status(409).json({ error: 'You already registered a team here, or that team name is taken.' });
    throw err;
  }
});

app.get('/api/teams/mine', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT tm.*, t.name AS tournament_name FROM teams tm
       JOIN tournaments t ON t.id = tm.tournament_id
       WHERE tm.captain_id = ? ORDER BY tm.id DESC`
    )
    .all(req.user.id);
  res.json(rows.map((r) => ({ ...r, members: JSON.parse(r.members) })));
});

app.get('/api/notifications', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id));
});

/* ======================================================================
   ADMIN: TOURNAMENTS & SCHEDULES
   ====================================================================== */
app.get('/api/admin/mail-status', ...admin, (req, res) => {
  const s = mailStatus();
  res.json({ configured: s.configured, provider: s.provider });
});

app.get('/api/admin/mail-settings', ...admin, (req, res) => res.json(mailStatus()));

app.put('/api/admin/mail-settings', ...admin, (req, res) => {
  const { brevoApiKey, fromEmail, fromName, removeKey } = req.body || {};
  const email = String(fromEmail ?? '').trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid sender email address.' });

  if (removeKey) {
    setSetting(SETTING_KEYS.apiKey, null);
  } else if (typeof brevoApiKey === 'string' && brevoApiKey.trim()) {
    const key = brevoApiKey.trim();
    if (key.length > 200) return res.status(400).json({ error: 'That API key looks too long.' });
    setSetting(SETTING_KEYS.apiKey, key);
  }

  setSetting(SETTING_KEYS.fromEmail, email);
  const name = String(fromName ?? '').trim();
  setSetting(SETTING_KEYS.fromName, name || null);
  res.json(mailStatus());
});

app.post('/api/admin/mail-settings/test', ...admin, wrap(async (req, res) => {
  const cfg = mailConfig();
  if (cfg.provider === 'none') return res.status(400).json({ error: 'Save a Brevo API key first.' });
  const to = String(req.body?.to || req.user.email).trim();
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter a valid email address to send the test to.' });
  try {
    await deliverMail(cfg, {
      to,
      subject: 'Test email from the tournament system',
      text: 'If you received this message, email delivery is working.',
    });
    res.json({ ok: true, to });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/admin/tournaments', ...admin, (req, res) => {
  const { name, description } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Tournament name is required.' });
  const info = db
    .prepare('INSERT INTO tournaments (name, description) VALUES (?, ?)')
    .run(name.trim(), String(description || '').trim());
  res.status(201).json({ id: info.lastInsertRowid });
});

app.post('/api/admin/schedules', ...admin, (req, res) => {
  const { tournamentId, title, date, time, venue } = req.body || {};
  if (!db.prepare('SELECT id FROM tournaments WHERE id = ?').get(+tournamentId))
    return res.status(404).json({ error: 'Tournament not found.' });
  if (![title, date, time, venue].every((v) => typeof v === 'string' && v.trim()))
    return res.status(400).json({ error: 'Title, date, time and venue are required.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    return res.status(400).json({ error: 'Invalid date or time format.' });
  const info = db
    .prepare('INSERT INTO schedules (tournament_id, title, match_date, match_time, venue) VALUES (?, ?, ?, ?, ?)')
    .run(+tournamentId, title.trim(), date, time, venue.trim());
  res.status(201).json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/schedules/:id', ...admin, (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});

/* ======================================================================
   ADMIN: TEAM APPROVAL
   ====================================================================== */
app.get('/api/admin/teams', ...admin, (req, res) => {
  const tid = req.query.tournamentId ? +req.query.tournamentId : null;
  const rows = db
    .prepare(
      `SELECT tm.*, t.name AS tournament_name, u.full_name AS captain_name, u.email AS captain_email,
              u.ign AS captain_ign, u.school_id, u.program
       FROM teams tm
       JOIN tournaments t ON t.id = tm.tournament_id
       JOIN users u ON u.id = tm.captain_id
       WHERE (? IS NULL OR tm.tournament_id = ?)
       ORDER BY tm.id DESC`
    )
    .all(tid, tid);
  res.json(rows.map((r) => ({ ...r, members: JSON.parse(r.members) })));
});

app.put('/api/admin/teams/:id/status', ...admin, wrap(async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(+req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  db.prepare('UPDATE teams SET status = ? WHERE id = ?').run(status, team.id);
  if (status !== 'pending') {
    const cap = db.prepare('SELECT email FROM users WHERE id = ?').get(team.captain_id);
    await notify(
      team.captain_id,
      `Team ${team.name} was ${status}`,
      status === 'approved'
        ? `Your team "${team.name}" has been approved. Watch this page for schedules and the bracket.`
        : `Your team "${team.name}" registration was rejected. Contact the organizers for details.`,
      { email: cap ? cap.email : null }
    );
  }
  res.json({ ok: true });
}));

/* ======================================================================
   ADMIN: BRACKET (8-team single elimination, labels 7-13 like the sample)
   Round 1: 7 = seed1 v seed8, 8 = seed4 v seed5, 9 = seed2 v seed7, 10 = seed3 v seed6
   Round 2: 11 = W7 v W8, 12 = W9 v W10      Final: 13 = W11 v W12
   ====================================================================== */
const NEXT = { 7: [11, 'team1_id'], 8: [11, 'team2_id'], 9: [12, 'team1_id'], 10: [12, 'team2_id'], 11: [13, 'team1_id'], 12: [13, 'team2_id'] };
const R1 = [[7, 1, 8], [8, 4, 5], [9, 2, 7], [10, 3, 6]];

function setWinner(tid, label, winnerId) {
  db.prepare('UPDATE matches SET winner_id = ? WHERE tournament_id = ? AND label = ?').run(winnerId, tid, label);
  const next = NEXT[label];
  if (next) db.prepare(`UPDATE matches SET ${next[1]} = ? WHERE tournament_id = ? AND label = ?`).run(winnerId, tid, next[0]);
}

app.post('/api/admin/tournaments/:id/bracket', ...admin, (req, res) => {
  const tid = +req.params.id;
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tid);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });

  const ids = (Array.isArray(req.body?.seeds) ? req.body.seeds : []).filter(Boolean).map(Number);
  if (ids.length < 4 || ids.length > 8) return res.status(400).json({ error: 'Choose between 4 and 8 approved teams.' });
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'A team was selected twice.' });
  for (const id of ids) {
    const tm = db.prepare('SELECT status, tournament_id FROM teams WHERE id = ?').get(id);
    if (!tm || tm.tournament_id !== tid || tm.status !== 'approved')
      return res.status(400).json({ error: 'Only approved teams of this tournament can be seeded.' });
  }
  const seedTeam = {};
  ids.forEach((id, i) => (seedTeam[i + 1] = id)); // seeds beyond ids.length are BYEs

  db.transaction(() => {
    db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tid);
    db.prepare('UPDATE teams SET seed = NULL WHERE tournament_id = ?').run(tid);
    ids.forEach((id, i) => db.prepare('UPDATE teams SET seed = ? WHERE id = ?').run(i + 1, id));

    const ins = db.prepare('INSERT INTO matches (tournament_id, round, label, team1_id, team2_id) VALUES (?, ?, ?, ?, ?)');
    for (const [label, a, b] of R1) ins.run(tid, 1, label, seedTeam[a] || null, seedTeam[b] || null);
    ins.run(tid, 2, 11, null, null);
    ins.run(tid, 2, 12, null, null);
    ins.run(tid, 3, 13, null, null);

    // BYEs: a team with no opponent advances automatically.
    for (const [label] of R1) {
      const m = db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND label = ?').get(tid, label);
      if (m.team1_id && !m.team2_id) setWinner(tid, label, m.team1_id);
      else if (!m.team1_id && m.team2_id) setWinner(tid, label, m.team2_id);
    }
    db.prepare(`UPDATE tournaments SET status = 'ongoing', champion_team_id = NULL, certificates_sent = 0 WHERE id = ?`).run(tid);
  })();

  res.status(201).json(getBracket(tid));
});

app.put('/api/admin/matches/:id', ...admin, (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(+req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  if (!m.team1_id || !m.team2_id) return res.status(400).json({ error: 'Both teams must be known before scoring.' });

  const s1 = Number(req.body?.score1);
  const s2 = Number(req.body?.score2);
  if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 < 0 || s2 < 0)
    return res.status(400).json({ error: 'Scores must be whole numbers.' });
  if (s1 === s2) return res.status(400).json({ error: 'A match cannot end in a tie.' });

  const next = NEXT[m.label];
  if (next) {
    const nm = db.prepare('SELECT winner_id FROM matches WHERE tournament_id = ? AND label = ?').get(m.tournament_id, next[0]);
    if (nm?.winner_id) return res.status(400).json({ error: `Match ${next[0]} was already played. Edit it first.` });
  }

  const winner = s1 > s2 ? m.team1_id : m.team2_id;
  db.transaction(() => {
    db.prepare('UPDATE matches SET score1 = ?, score2 = ? WHERE id = ?').run(s1, s2, m.id);
    setWinner(m.tournament_id, m.label, winner);
    if (m.label === 13) {
      db.prepare(`UPDATE tournaments SET champion_team_id = ?, status = 'completed' WHERE id = ?`).run(winner, m.tournament_id);
    }
  })();

  // Final decided: automatically email certificates to the winning team.
  if (m.label === 13 && process.env.AUTO_CERTIFICATES !== 'false') {
    sendCertificates(m.tournament_id).catch((e) => console.error('Auto-certificate error:', e.message));
  }
  res.json(getBracket(m.tournament_id));
});

/* ======================================================================
   ADMIN: NOTIFICATIONS & CERTIFICATES
   ====================================================================== */
app.post('/api/admin/tournaments/:id/notify-qualified', ...admin, wrap(async (req, res) => {
  const tid = +req.params.id;
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tid);
  if (!t) return res.status(404).json({ error: 'Tournament not found.' });

  const teams = db
    .prepare(
      `SELECT tm.*, u.email FROM teams tm JOIN users u ON u.id = tm.captain_id
       WHERE tm.tournament_id = ? AND tm.status = 'approved'`
    )
    .all(tid);
  if (!teams.length) return res.status(400).json({ error: 'No approved teams to notify.' });

  const sched = db.prepare('SELECT * FROM schedules WHERE tournament_id = ? ORDER BY match_date, match_time').all(tid);
  const schedText = sched.length
    ? '\n\nSchedule:\n' + sched.map((s) => `- ${s.title}: ${s.match_date} ${s.match_time} at ${s.venue}`).join('\n')
    : '';
  const extra = String(req.body?.message || '').trim();

  let emailed = 0;
  for (const tm of teams) {
    const msg =
      `Congratulations! Your team "${tm.name}" has qualified for ${t.name}.` +
      (extra ? `\n\n${extra}` : '') + schedText;
    const ok = await notify(tm.captain_id, `You're qualified: ${t.name}`, msg, { email: tm.email });
    if (ok) emailed++;
    db.prepare('UPDATE teams SET qualified_notified = 1 WHERE id = ?').run(tm.id);
  }
  res.json({ teams: teams.length, emailed, mailConfigured: mailStatus().configured });
}));

app.post('/api/admin/tournaments/:id/send-certificates', ...admin, wrap(async (req, res) => {
  try {
    res.json(await sendCertificates(+req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/* ====================================================================== */
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, () => console.log(`ML Tournament system running at http://localhost:${PORT}`));
