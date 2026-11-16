/* ML Tournament Registration System - frontend (vanilla JS) */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = localStorage.getItem('token');
let me = null;

/* ---------- helpers ---------- */
async function api(url, method = 'GET', body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4200);
}
const fail = (e) => toast(e.message, true);

const fmtDate = (d) => new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const fmtTime = (t) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const cell = (c) => (c && c.html !== undefined ? c.html : esc(c));
const table = (heads, rows) =>
  `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
const panel = (html) => ($('#panel').innerHTML = html);
const tournamentOptions = (list, selected) =>
  list.map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

/* ---------- auth screens ---------- */
$('#authTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#authTabs button').forEach((x) => x.classList.toggle('active', x === b));
  ['loginForm', 'registerForm', 'adminForm'].forEach((id) => ($('#' + id).hidden = id !== b.dataset.form));
});

async function submitAuth(url, body) {
  try {
    const data = await api(url, 'POST', body);
    token = data.token;
    localStorage.setItem('token', token);
    me = data.user;
    showApp();
  } catch (err) {
    fail(err);
  }
}
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  submitAuth('/auth/login', { email: f.get('email'), password: f.get('password') });
});
$('#adminForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  submitAuth('/auth/login', { email: f.get('email'), password: f.get('password'), adminLogin: true });
});
$('#registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAuth('/auth/register', Object.fromEntries(new FormData(e.target)));
});
$('#logoutBtn').addEventListener('click', () => {
  token = null;
  me = null;
  localStorage.removeItem('token');
  showAuth();
});

function showAuth() {
  $('#viewAuth').hidden = false;
  $('#viewApp').hidden = true;
  $('#userbox').hidden = true;
}

/* ---------- app shell ---------- */
const USER_TABS = [['schedule', 'Schedule'], ['register', 'Register Team'], ['myteams', 'My Teams'], ['bracket', 'Bracket'], ['inbox', 'Notifications']];
const ADMIN_TABS = [['a_tournaments', 'Tournaments & Schedule'], ['a_teams', 'Team Approvals'], ['a_bracket', 'Bracket'], ['a_notify', 'Notify & Certificates'], ['a_settings', 'Settings']];

function showApp() {
  $('#viewAuth').hidden = true;
  $('#viewApp').hidden = false;
  $('#userbox').hidden = false;
  $('#userLabel').textContent = me.email;
  $('#avatar').textContent = (me.full_name || me.email || '?').trim().charAt(0).toUpperCase();
  $('#rolePill').hidden = me.role !== 'admin';
  const tabs = me.role === 'admin' ? ADMIN_TABS : USER_TABS;
  $('#mainTabs').innerHTML = tabs.map(([k, label]) => `<button data-tab="${k}">${label}</button>`).join('');
  openTab(tabs[0][0]);
}
$('#mainTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) openTab(b.dataset.tab);
});
function openTab(key) {
  document.querySelectorAll('#mainTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
  panel('<p class="muted">Loading...</p>');
  Promise.resolve(loaders[key]()).catch(fail);
}

/* ---------- BRACKET RENDERING (shared by user and admin) ---------- */
function rowHTML(m, n) {
  const name = m['team' + n + '_name'];
  const seed = m['seed' + n];
  const score = m['score' + n];
  const isBye = !name && m.round === 1 && m.winner_id;
  const win = m.winner_id && m.winner_id === m['team' + n + '_id'];
  return `<div class="brow">
    <span class="bseed">${seed ?? ''}</span>
    <span class="bname ${isBye ? 'bye' : ''}">${esc(isBye ? 'BYE' : name || '')}</span>
    <span class="bscore ${win && score != null ? 'win' : ''}">${score ?? 0}</span>
  </div>`;
}
function matchHTML(m, editable) {
  const ready = editable && m.team1_id && m.team2_id;
  return `<div class="bmatch ${ready ? 'clickable' : ''}" ${ready ? `data-match="${m.id}"` : ''}>
    <span class="bnum">${m.label}</span>${rowHTML(m, 1)}${rowHTML(m, 2)}</div>`;
}
function bracketHTML(matches, editable) {
  if (!matches.length) return '<p class="muted">The bracket has not been created yet.</p>';
  const by = (l) => matches.find((m) => m.label === l);
  const col = (labels, hasNext) =>
    `<div class="bcol ${hasNext ? 'has-next' : ''}">${labels.map((l) => `<div class="bslot">${matchHTML(by(l), editable)}</div>`).join('')}</div>`;
  return `<div class="bracket-scroll"><div class="bracket">${col([7, 8, 9, 10], true)}${col([11, 12], true)}${col([13], false)}</div></div>`;
}

/* Renders a bracket viewer; admin mode adds score editing. */
async function bracketPanel(admin) {
  const tournaments = await api('/tournaments');
  if (!tournaments.length) return panel(`<h2>Bracket</h2><p class="muted">No tournaments yet.</p>`);
  let tid = tournaments[0].id;

  const draw = async () => {
    const t = tournaments.find((x) => x.id === tid);
    const matches = await api(`/tournaments/${tid}/bracket`);
    let seedForm = '';
    if (admin) {
      const teams = (await api(`/admin/teams?tournamentId=${tid}`)).filter((x) => x.status === 'approved');
      const opts = (i) =>
        `<option value="">(BYE)</option>` + teams.map((tm, j) => `<option value="${tm.id}" ${j === i ? 'selected' : ''}>${esc(tm.name)}</option>`).join('');
      seedForm = `
        <h3>Create / reset bracket</h3>
        <p class="muted">Pick 4 to 8 approved teams in seed order (${teams.length} approved). Empty seeds at the end become BYEs. Creating a bracket closes registration and replaces any existing bracket.</p>
        <form id="seedForm" class="grid2">
          ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<label>Seed ${i + 1}<select name="seed">${opts(i)}</select></label>`).join('')}
          <div><button class="btn dark" type="submit">${matches.length ? 'Recreate bracket' : 'Create bracket'}</button></div>
        </form>`;
    }
    panel(`
      <h2>Bracket</h2>
      <label style="max-width:360px">Tournament<select id="bracketTournament">${tournamentOptions(tournaments, tid)}</select></label>
      <p>${badge(t.status)} ${t.champion ? `<strong>Champion: ${esc(t.champion)}</strong>` : ''}</p>
      ${admin && matches.length ? '<p class="muted">Click a match to enter its score. The winner advances automatically.</p>' : ''}
      <div id="bracketArea">${bracketHTML(matches, admin)}</div>
      <div id="scoreEditor" class="score-editor"></div>
      ${seedForm}`);

    $('#bracketTournament').onchange = (e) => { tid = +e.target.value; draw().catch(fail); };
    if (!admin) return;

    $('#bracketArea').onclick = (e) => {
      const el = e.target.closest('[data-match]');
      if (!el) return;
      document.querySelectorAll('.bmatch.selected').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      const m = matches.find((x) => x.id === +el.dataset.match);
      $('#scoreEditor').innerHTML = `
        <div class="card"><strong>Match ${m.label}</strong>
        <form id="scoreForm" class="form inline">
          <label>${esc(m.team1_name)}<input type="number" min="0" name="score1" value="${m.score1 ?? 0}" required /></label>
          <label>${esc(m.team2_name)}<input type="number" min="0" name="score2" value="${m.score2 ?? 0}" required /></label>
          <button class="btn" type="submit">Save score</button>
        </form></div>`;
      $('#scoreForm').onsubmit = async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        try {
          await api(`/admin/matches/${m.id}`, 'PUT', { score1: f.get('score1'), score2: f.get('score2') });
          toast('Score saved.');
          const fresh = await api('/tournaments');
          tournaments.splice(0, tournaments.length, ...fresh);
          draw().catch(fail);
        } catch (err) { fail(err); }
      };
    };

    $('#seedForm').onsubmit = async (e) => {
      e.preventDefault();
      const seeds = [...e.target.querySelectorAll('select[name=seed]')].map((s) => s.value).filter(Boolean).map(Number);
      if (matches.length && !confirm('This will erase the current bracket and all scores. Continue?')) return;
      try {
        await api(`/admin/tournaments/${tid}/bracket`, 'POST', { seeds });
        toast('Bracket created.');
        const fresh = await api('/tournaments');
        tournaments.splice(0, tournaments.length, ...fresh);
        draw().catch(fail);
      } catch (err) { fail(err); }
    };
  };
  await draw();
}

/* ---------- loaders (one per tab) ---------- */
const loaders = {
  /* ===== USER ===== */
  async schedule() {
    const rows = await api('/schedules');
    panel(`<h2>Match Schedule</h2>${
      rows.length
        ? table(['Tournament', 'Match', 'Date', 'Time', 'Venue'], rows.map((r) => [r.tournament_name, r.title, fmtDate(r.match_date), fmtTime(r.match_time), r.venue]))
        : '<p class="muted">No schedules posted yet.</p>'
    }`);
  },

  async register() {
    const open = (await api('/tournaments')).filter((t) => t.status === 'registration');
    if (!open.length) return panel('<h2>Register Team</h2><p class="muted">No tournaments are open for registration right now.</p>');
    const rows = [1, 2, 3, 4, 5].map((i) => `
      <div class="member-row">
        <label>${i <= 4 ? `Player ${i + 1}` : 'Substitute (optional)'} full name<input name="m_name_${i}" ${i <= 4 ? 'required' : ''} /></label>
        <label>IGN<input name="m_ign_${i}" ${i <= 4 ? 'required' : ''} /></label>
        <label>Email (optional)<input type="email" name="m_email_${i}" /></label>
      </div>`).join('');
    panel(`
      <h2>Register Team</h2>
      <div class="note">You (${esc(me.full_name)} / ${esc(me.ign)}) are registered as team captain. Add your 4 other players. A player's email is optional, but lets them receive their own certificate.</div>
      <form id="teamForm" class="form">
        <div class="grid2">
          <label>Tournament<select name="tournamentId">${tournamentOptions(open)}</select></label>
          <label>Team name<input name="name" required /></label>
        </div>
        ${rows}
        <div><button class="btn" type="submit">Submit registration</button></div>
      </form>`);
    $('#teamForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const members = [1, 2, 3, 4, 5].map((i) => ({ name: f.get('m_name_' + i), ign: f.get('m_ign_' + i), email: f.get('m_email_' + i) }));
      try {
        await api('/teams', 'POST', { tournamentId: f.get('tournamentId'), name: f.get('name'), members });
        toast('Team submitted. Wait for admin approval.');
        openTab('myteams');
      } catch (err) { fail(err); }
    };
  },

  async myteams() {
    const teams = await api('/teams/mine');
    panel(`<h2>My Teams</h2>${
      teams.length
        ? table(['Team', 'Tournament', 'Status', 'Players'], teams.map((t) => [
            t.name, t.tournament_name, { html: badge(t.status) },
            { html: esc(`${me.ign}, ` + t.members.map((m) => m.ign).join(', ')) },
          ]))
        : '<p class="muted">You have not registered a team yet.</p>'
    }`);
  },

  bracket: () => bracketPanel(false),

  async inbox() {
    const list = await api('/notifications');
    panel(`<h2>Notifications</h2><p class="muted">Messages are also emailed to ${esc(me.email)}.</p>${
      list.length
        ? list.map((n) => `<div class="notif"><strong>${esc(n.subject)}</strong><br>${esc(n.message)}<small>${esc(n.created_at)} UTC${n.emailed ? ' - emailed' : ''}</small></div>`).join('')
        : '<p class="muted">Nothing yet.</p>'
    }`);
  },

  /* ===== ADMIN ===== */
  async a_tournaments() {
    const [tournaments, schedules] = await Promise.all([api('/tournaments'), api('/schedules')]);
    panel(`
      <h2>Tournaments</h2>
      <form id="tForm" class="form inline">
        <label>Name<input name="name" required /></label>
        <label>Description<input name="description" /></label>
        <button class="btn" type="submit">Create tournament</button>
      </form>
      ${tournaments.length ? table(['Tournament', 'Status', 'Teams', 'Champion'], tournaments.map((t) => [t.name, { html: badge(t.status) }, t.team_count, t.champion || '-'])) : ''}

      <h3>Create schedule</h3>
      ${tournaments.length ? `
      <form id="sForm" class="form inline">
        <label>Tournament<select name="tournamentId">${tournamentOptions(tournaments)}</select></label>
        <label>Match title<input name="title" placeholder="Quarterfinals" required /></label>
        <label>Date<input type="date" name="date" required /></label>
        <label>Time<input type="time" name="time" required /></label>
        <label>Venue / location<input name="venue" required /></label>
        <button class="btn" type="submit">Add schedule</button>
      </form>` : '<p class="muted">Create a tournament first.</p>'}
      ${schedules.length ? table(['Tournament', 'Match', 'Date', 'Time', 'Venue', ''], schedules.map((s) => [
        s.tournament_name, s.title, fmtDate(s.match_date), fmtTime(s.match_time), s.venue,
        { html: `<button class="btn small bad" data-del="${s.id}">Delete</button>` },
      ])) : ''}`);

    $('#tForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await api('/admin/tournaments', 'POST', Object.fromEntries(f)); toast('Tournament created.'); openTab('a_tournaments'); } catch (err) { fail(err); }
    };
    const sForm = $('#sForm');
    if (sForm) sForm.onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/admin/schedules', 'POST', Object.fromEntries(new FormData(e.target))); toast('Schedule added.'); openTab('a_tournaments'); } catch (err) { fail(err); }
    };
    $('#panel').onclick = async (e) => {
      const b = e.target.closest('[data-del]');
      if (!b || !confirm('Delete this schedule?')) return;
      try { await api('/admin/schedules/' + b.dataset.del, 'DELETE'); openTab('a_tournaments'); } catch (err) { fail(err); }
    };
  },

  async a_teams() {
    const teams = await api('/admin/teams');
    panel(`<h2>Team Registrations</h2>${
      teams.length
        ? table(['Team', 'Tournament', 'Captain', 'Players', 'Status', 'Action'], teams.map((t) => [
            t.name, t.tournament_name,
            { html: `${esc(t.captain_name)} (${esc(t.captain_ign)})<br><span class="muted">${esc(t.captain_email)}<br>${esc(t.school_id)} - ${esc(t.program)}</span>` },
            { html: t.members.map((m) => `${esc(m.name)} (${esc(m.ign)})`).join('<br>') },
            { html: badge(t.status) },
            { html: `<button class="btn small ok" data-id="${t.id}" data-status="approved">Approve</button>
                     <button class="btn small bad" data-id="${t.id}" data-status="rejected">Reject</button>` },
          ]))
        : '<p class="muted">No registrations yet.</p>'
    }`);
    $('#panel').onclick = async (e) => {
      const b = e.target.closest('[data-status]');
      if (!b) return;
      try { await api(`/admin/teams/${b.dataset.id}/status`, 'PUT', { status: b.dataset.status }); toast(`Team ${b.dataset.status}.`); openTab('a_teams'); } catch (err) { fail(err); }
    };
  },

  a_bracket: () => bracketPanel(true),

  async a_notify() {
    const [tournaments, mail] = await Promise.all([api('/tournaments'), api('/admin/mail-status')]);
    if (!tournaments.length) return panel('<h2>Notify & Certificates</h2><p class="muted">No tournaments yet.</p>');
    panel(`
      <h2>Notify & Certificates</h2>
      ${mail.configured ? '' : '<div class="note">Email is not configured. Add your Brevo API key in the <button class="btn small" id="goSettings" type="button">Settings</button> tab. Notifications are still saved in-app but no emails will be sent.</div>'}
      <label style="max-width:360px">Tournament<select id="nTournament">${tournamentOptions(tournaments)}</select></label>

      <h3>1. Notify qualified teams</h3>
      <p class="muted">Emails the captain of every approved team, including the schedule.</p>
      <form id="notifyForm" class="form">
        <label>Extra message (optional)<textarea name="message" rows="3"></textarea></label>
        <div><button class="btn" type="submit">Send qualification emails</button></div>
      </form>

      <h3>2. Certificates for the winning team</h3>
      <p class="muted">Sent automatically when the final (match 13) is scored. Use this button to resend.</p>
      <button id="certBtn" class="btn dark">Send / resend certificates</button>`);

    const goSettings = $('#goSettings');
    if (goSettings) goSettings.onclick = () => openTab('a_settings');

    $('#notifyForm').onsubmit = async (e) => {
      e.preventDefault();
      const id = $('#nTournament').value;
      try {
        const r = await api(`/admin/tournaments/${id}/notify-qualified`, 'POST', { message: new FormData(e.target).get('message') });
        toast(`${r.teams} team(s) notified, ${r.emailed} email(s) sent.`);
      } catch (err) { fail(err); }
    };
    $('#certBtn').onclick = async () => {
      try {
        const r = await api(`/admin/tournaments/${$('#nTournament').value}/send-certificates`, 'POST');
        toast(`Certificates for ${r.team}: ${r.certificates} PDF(s) created${r.allEmailed ? ' and emailed.' : '. Email not delivered (check Settings).'}`);
      } catch (err) { fail(err); }
    };
  },

  async a_settings() {
    const s = await api('/admin/mail-settings');
    const providerText =
      { brevo: 'Brevo API', gmail: 'Gmail SMTP (.env fallback)', none: 'Not configured' }[s.provider] || s.provider;
    panel(`
      <h2>Settings</h2>
      <h3>Email sender</h3>
      <p>Provider: <strong>${esc(providerText)}</strong>
        ${s.configured ? '<span class="badge approved">ready</span>' : '<span class="badge rejected">not ready</span>'}
        ${
          s.keySource === 'database'
            ? `<span class="muted"> - saved Brevo key ${esc(s.keyHint)}</span>`
            : s.keySource === 'environment'
              ? `<span class="muted"> - using BREVO_API_KEY from the server environment</span>`
              : ''
        }</p>
      <div class="note">Create a free Brevo account, then copy an API key from Brevo &rarr; SMTP &amp; API &rarr; API Keys. The sender email must be verified as a sender in Brevo.</div>
      ${s.keySource === 'environment' ? '<div class="note">An API key is already provided by the server environment. Saving a key here overrides it.</div>' : ''}
      <form id="mailForm" class="form" style="max-width:560px">
        <label>Brevo API key
          <input type="password" name="brevoApiKey" placeholder="${s.hasKey ? 'Leave blank to keep the saved key' : 'xkeysib-...'}" autocomplete="off" />
        </label>
        <div class="grid2">
          <label>Sender email<input type="email" name="fromEmail" value="${esc(s.fromEmail)}" placeholder="you@example.com" required /></label>
          <label>Sender name<input name="fromName" value="${esc(s.fromName)}" /></label>
        </div>
        <div>
          <button class="btn" type="submit">Save email settings</button>
          ${s.hasKey ? '<button class="btn small bad" id="removeKeyBtn" type="button" style="margin-left:8px">Remove saved key</button>' : ''}
        </div>
      </form>

      <h3>Send a test email</h3>
      <form id="testForm" class="form inline">
        <label>Send to<input type="email" name="to" value="${esc(me.email)}" required /></label>
        <button class="btn dark" type="submit">Send test email</button>
      </form>`);

    $('#mailForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/admin/mail-settings', 'PUT', Object.fromEntries(new FormData(e.target)));
        toast('Email settings saved.');
        openTab('a_settings');
      } catch (err) { fail(err); }
    };

    const removeBtn = $('#removeKeyBtn');
    if (removeBtn)
      removeBtn.onclick = async () => {
        if (!confirm('Remove the saved Brevo API key?')) return;
        try {
          await api('/admin/mail-settings', 'PUT', { removeKey: true, fromEmail: s.fromEmail, fromName: s.fromName });
          toast('API key removed.');
          openTab('a_settings');
        } catch (err) { fail(err); }
      };

    $('#testForm').onsubmit = async (e) => {
      e.preventDefault();
      const to = new FormData(e.target).get('to');
      try {
        const r = await api('/admin/mail-settings/test', 'POST', { to });
        toast(`Test email sent to ${r.to}.`);
      } catch (err) { fail(err); }
    };
  },
};

/* ---------- start ---------- */
(async function init() {
  if (!token) return showAuth();
  try {
    me = await api('/me');
    showApp();
  } catch {
    localStorage.removeItem('token');
    token = null;
    showAuth();
  }
})();
