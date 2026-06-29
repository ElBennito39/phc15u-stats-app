const DEFAULT_TEAM = {
  id: 'phc-15u-2026-27',
  name: 'PHC 15U',
  season: '2026-27',
  defaultGameMinutes: 51
};

const DB_NAME = 'phc15u-stats-v2';
const DB_VERSION = 1;
const DRAFT_KEY = 'phc15u-current-draft-v2';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const app = $('#app');
const modal = $('#modal');
const modalContent = $('#modalContent');
const jsonFileInput = $('#jsonFileInput');

let db;
let state = {
  route: 'home',
  games: [],
  team: { ...DEFAULT_TEAM },
  roster: [],
  currentDraft: null,
  editingId: null,
  pendingImportMode: 'auto'
};

function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stablePlayerId(player) {
  const base = `${player.jersey || 'x'}-${player.first || ''}-${player.last || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || uid('player');
  return `p-${base}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function int(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clampNonnegative(n) {
  return Math.max(0, int(n, 0));
}

function percent(numerator, denominator) {
  if (!denominator) return '';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function savePct(saves, shotsAgainst) {
  if (!shotsAgainst) return '';
  return (saves / shotsAgainst).toFixed(3).replace(/^0/, '');
}

function fmtDate(value) {
  if (!value) return 'No date';
  const parts = String(value).split('-');
  if (parts.length !== 3) return value;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

function safeFilePart(value) {
  return String(value || 'export').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'export';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(',')).join('\n');
}

function normalizePosition(position) {
  const p = String(position || '').trim().toLowerCase();
  if (p === 'g' || p.includes('goal')) return 'Goalie';
  if (p === 'd' || p.includes('def')) return 'Defense';
  return 'Forward';
}

function normalizePlayer(raw) {
  const first = String(raw.first ?? raw.First ?? raw['First Name'] ?? '').trim();
  const last = String(raw.last ?? raw.Last ?? raw['Last Name'] ?? '').trim();
  const name = String(raw.name ?? raw.Name ?? '').trim();
  let parsedFirst = first;
  let parsedLast = last;
  if ((!parsedFirst || !parsedLast) && name) {
    const parts = name.split(/\s+/);
    parsedFirst = parsedFirst || parts.shift() || '';
    parsedLast = parsedLast || parts.join(' ');
  }
  const player = {
    id: String(raw.id ?? raw.ID ?? '').trim(),
    first: parsedFirst,
    last: parsedLast,
    jersey: int(raw.jersey ?? raw.Jersey ?? raw['#'] ?? raw.Number ?? raw.number, 0),
    position: normalizePosition(raw.position ?? raw.Position ?? raw.Pos ?? raw.pos)
  };
  if (!player.id) player.id = stablePlayerId(player);
  return player;
}

function sanitizeRoster(rawRoster) {
  if (!Array.isArray(rawRoster)) return [];
  const seen = new Set();
  const roster = [];
  for (const raw of rawRoster) {
    const p = normalizePlayer(raw);
    if (!p.first && !p.last) continue;
    let id = p.id;
    let i = 2;
    while (seen.has(id)) id = `${p.id}-${i++}`;
    seen.add(id);
    roster.push({ ...p, id });
  }
  return roster.sort((a, b) => a.jersey - b.jersey || a.last.localeCompare(b.last));
}

function roster() {
  return state.roster || [];
}

function hasRoster() {
  return roster().length > 0;
}

function playersById() {
  return Object.fromEntries(roster().map(p => [p.id, p]));
}

function skaters() {
  return roster().filter(p => p.position.toLowerCase() !== 'goalie');
}

function goalies() {
  return roster().filter(p => p.position.toLowerCase() === 'goalie');
}

function playerLabel(id, fallback = '—') {
  const p = playersById()[id];
  return p ? `#${p.jersey} ${p.first} ${p.last}` : fallback;
}

function updateHeader() {
  $('#appTitle').textContent = state.team.name || DEFAULT_TEAM.name;
  $('#subtitle').textContent = `${state.team.season || DEFAULT_TEAM.season} local-first stat tracker`;
}

function clearAppHandlers() {
  app.oninput = null;
  app.onchange = null;
}

function downloadOrShare(filename, mimeType, contents) {
  const blob = new Blob([contents], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });

  if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
    navigator.share({ files: [file], title: filename }).catch(() => fallbackDownload(filename, blob));
    return;
  }
  fallbackDownload(filename, blob);
}

function fallbackDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function openModal(html) {
  modalContent.innerHTML = html;
  if (typeof modal.showModal === 'function') modal.showModal();
  else alert(modalContent.innerText);
}

function closeModal() {
  if (modal.open) modal.close();
}

function initDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('games')) {
        const store = database.createObjectStore('games', { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getMeta(key) {
  const result = await requestToPromise(tx('meta').get(key));
  return result?.value;
}

async function putMeta(key, value) {
  return requestToPromise(tx('meta', 'readwrite').put({ key, value }));
}

async function loadConfig() {
  const storedTeam = await getMeta('team');
  const storedRoster = await getMeta('roster');
  state.team = { ...DEFAULT_TEAM, ...(storedTeam || {}) };
  state.roster = sanitizeRoster(storedRoster || []);
  updateHeader();
}

async function saveConfig() {
  state.team = { ...DEFAULT_TEAM, ...state.team };
  state.roster = sanitizeRoster(state.roster || []);
  await putMeta('team', state.team);
  await putMeta('roster', state.roster);
  updateHeader();
}

function getAllGames() {
  return new Promise((resolve, reject) => {
    const request = tx('games').getAll();
    request.onsuccess = () => resolve(request.result.map(sanitizeGame).sort((a, b) => (b.date || '').localeCompare(a.date || '')));
    request.onerror = () => reject(request.error);
  });
}

function putGame(game) {
  return new Promise((resolve, reject) => {
    const clean = sanitizeGame({ ...game, updatedAt: new Date().toISOString() });
    const request = tx('games', 'readwrite').put(clean);
    request.onsuccess = () => resolve(clean);
    request.onerror = () => reject(request.error);
  });
}

function deleteGame(id) {
  return new Promise((resolve, reject) => {
    const request = tx('games', 'readwrite').delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearGames() {
  return new Promise((resolve, reject) => {
    const request = tx('games', 'readwrite').clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function refreshGames() {
  state.games = await getAllGames();
}

function optionsForPlayers(selectedId = '', includeBlank = false, label = 'None') {
  const blank = includeBlank ? `<option value="">${label}</option>` : '';
  return blank + roster()
    .slice()
    .sort((a, b) => a.jersey - b.jersey)
    .map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>#${p.jersey} ${p.first} ${p.last}</option>`)
    .join('');
}

function optionsForSkaters(selectedId = '', includeBlank = false, label = 'None') {
  const blank = includeBlank ? `<option value="">${label}</option>` : '';
  return blank + skaters()
    .slice()
    .sort((a, b) => a.jersey - b.jersey)
    .map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>#${p.jersey} ${p.first} ${p.last}</option>`)
    .join('');
}

function defaultGoalieStats() {
  return goalies().map((g, idx) => ({
    goalieId: g.id,
    minutes: idx === 0 ? state.team.defaultGameMinutes : 0,
    shotsAgainst: 0,
    goalsAgainst: 0
  }));
}

function newGame() {
  return {
    id: uid('game'),
    date: todayISO(),
    opponent: '',
    homeAway: 'Neutral',
    location: '',
    eventName: '',
    opponentGoals: 0,
    shotsFor: 0,
    ppOpps: 0,
    pkOpps: 0,
    pkGoalsAgainst: 0,
    emptyNetAgainst: 0,
    scoringPlays: [],
    penalties: [],
    goalieStats: defaultGoalieStats(),
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function sanitizeGame(game = {}) {
  const clean = { ...newGame(), ...game };
  clean.scoringPlays = Array.isArray(game.scoringPlays) ? game.scoringPlays.map(g => ({
    id: g.id || uid('goal'),
    strength: g.strength || 'EV',
    scorerId: g.scorerId || '',
    assist1Id: g.assist1Id || '',
    assist2Id: g.assist2Id || '',
    period: g.period || '',
    time: g.time || ''
  })) : [];
  clean.penalties = Array.isArray(game.penalties) ? game.penalties.map(p => ({
    id: p.id || uid('pen'),
    playerId: p.playerId || '',
    minutes: clampNonnegative(p.minutes),
    infraction: p.infraction || '',
    period: p.period || ''
  })) : [];
  const byGoalie = Object.fromEntries((game.goalieStats || []).map(g => [g.goalieId, g]));
  clean.goalieStats = goalies().map((g, idx) => {
    const existing = byGoalie[g.id] || {};
    return {
      goalieId: g.id,
      minutes: clampNonnegative(existing.minutes ?? (idx === 0 ? state.team.defaultGameMinutes : 0)),
      shotsAgainst: clampNonnegative(existing.shotsAgainst),
      goalsAgainst: clampNonnegative(existing.goalsAgainst)
    };
  });
  clean.opponentGoals = clampNonnegative(clean.opponentGoals);
  clean.shotsFor = clampNonnegative(clean.shotsFor);
  clean.ppOpps = clampNonnegative(clean.ppOpps);
  clean.pkOpps = clampNonnegative(clean.pkOpps);
  clean.pkGoalsAgainst = clampNonnegative(clean.pkGoalsAgainst);
  clean.emptyNetAgainst = clampNonnegative(clean.emptyNetAgainst);
  return clean;
}

function calculateGame(game) {
  const g = sanitizeGame(game);
  const playerStats = Object.fromEntries(roster().map(p => [p.id, {
    playerId: p.id,
    goals: 0,
    assists: 0,
    points: 0,
    ppGoals: 0,
    ppAssists: 0,
    ppPoints: 0,
    shGoals: 0,
    shAssists: 0,
    pim: 0
  }]));

  for (const play of g.scoringPlays) {
    if (play.scorerId && playerStats[play.scorerId]) {
      playerStats[play.scorerId].goals += 1;
      if (play.strength === 'PP') playerStats[play.scorerId].ppGoals += 1;
      if (play.strength === 'SH') playerStats[play.scorerId].shGoals += 1;
    }
    for (const aid of [play.assist1Id, play.assist2Id]) {
      if (aid && playerStats[aid]) {
        playerStats[aid].assists += 1;
        if (play.strength === 'PP') playerStats[aid].ppAssists += 1;
        if (play.strength === 'SH') playerStats[aid].shAssists += 1;
      }
    }
  }

  for (const pen of g.penalties) {
    if (pen.playerId && playerStats[pen.playerId]) playerStats[pen.playerId].pim += clampNonnegative(pen.minutes);
  }

  for (const stat of Object.values(playerStats)) {
    stat.points = stat.goals + stat.assists;
    stat.ppPoints = stat.ppGoals + stat.ppAssists;
  }

  const goalieLines = g.goalieStats.map(line => {
    const sa = clampNonnegative(line.shotsAgainst);
    const ga = clampNonnegative(line.goalsAgainst);
    const minutes = clampNonnegative(line.minutes);
    const saves = Math.max(0, sa - ga);
    return {
      ...line,
      minutes,
      shotsAgainst: sa,
      goalsAgainst: ga,
      saves,
      savePct: savePct(saves, sa),
      gaa: minutes ? ((ga / minutes) * state.team.defaultGameMinutes).toFixed(2) : ''
    };
  });

  const goalsFor = g.scoringPlays.length;
  const ppGoals = g.scoringPlays.filter(p => p.strength === 'PP').length;
  const shGoals = g.scoringPlays.filter(p => p.strength === 'SH').length;
  const enGoalsFor = g.scoringPlays.filter(p => p.strength === 'EN').length;
  const goalieShotsAgainst = goalieLines.reduce((sum, line) => sum + line.shotsAgainst, 0);
  const goalieGoalsAgainst = goalieLines.reduce((sum, line) => sum + line.goalsAgainst, 0);
  const goalieSaves = goalieLines.reduce((sum, line) => sum + line.saves, 0);
  const goalieMinutes = goalieLines.reduce((sum, line) => sum + line.minutes, 0);
  const opponentGoalsExpected = goalieGoalsAgainst + clampNonnegative(g.emptyNetAgainst);
  const pkSuccessful = Math.max(0, clampNonnegative(g.pkOpps) - clampNonnegative(g.pkGoalsAgainst));

  return {
    game: g,
    playerStats,
    goalieLines,
    team: {
      goalsFor,
      opponentGoals: clampNonnegative(g.opponentGoals),
      shotsFor: clampNonnegative(g.shotsFor),
      shotsAgainst: goalieShotsAgainst,
      shotDifferential: clampNonnegative(g.shotsFor) - goalieShotsAgainst,
      ppGoals,
      ppOpps: clampNonnegative(g.ppOpps),
      ppPct: percent(ppGoals, clampNonnegative(g.ppOpps)),
      pkGoalsAgainst: clampNonnegative(g.pkGoalsAgainst),
      pkOpps: clampNonnegative(g.pkOpps),
      pkSuccessful,
      pkPct: percent(pkSuccessful, clampNonnegative(g.pkOpps)),
      shGoals,
      enGoalsFor,
      emptyNetAgainst: clampNonnegative(g.emptyNetAgainst),
      goalieGoalsAgainst,
      goalieSaves,
      goalieMinutes,
      opponentGoalsExpected,
      teamSavePct: savePct(goalieSaves, goalieShotsAgainst),
      teamGaa: goalieMinutes ? ((goalieGoalsAgainst / goalieMinutes) * state.team.defaultGameMinutes).toFixed(2) : ''
    }
  };
}

function calculateSeason(games) {
  const totals = {
    games: games.length,
    wins: 0,
    losses: 0,
    ties: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    shotsFor: 0,
    shotsAgainst: 0,
    ppGoals: 0,
    ppOpps: 0,
    pkGoalsAgainst: 0,
    pkOpps: 0,
    goalieSaves: 0,
    goalieGoalsAgainst: 0,
    goalieMinutes: 0,
    emptyNetAgainst: 0
  };
  const playerTotals = Object.fromEntries(roster().map(p => [p.id, {
    playerId: p.id,
    goals: 0, assists: 0, points: 0, ppGoals: 0, ppAssists: 0, ppPoints: 0, shGoals: 0, shAssists: 0, pim: 0,
    goalieMinutes: 0, goalieShotsAgainst: 0, goalieGoalsAgainst: 0, goalieSaves: 0
  }]));

  for (const game of games) {
    const calc = calculateGame(game);
    totals.goalsFor += calc.team.goalsFor;
    totals.goalsAgainst += calc.team.opponentGoals;
    totals.shotsFor += calc.team.shotsFor;
    totals.shotsAgainst += calc.team.shotsAgainst;
    totals.ppGoals += calc.team.ppGoals;
    totals.ppOpps += calc.team.ppOpps;
    totals.pkGoalsAgainst += calc.team.pkGoalsAgainst;
    totals.pkOpps += calc.team.pkOpps;
    totals.goalieSaves += calc.team.goalieSaves;
    totals.goalieGoalsAgainst += calc.team.goalieGoalsAgainst;
    totals.goalieMinutes += calc.team.goalieMinutes;
    totals.emptyNetAgainst += calc.team.emptyNetAgainst;
    if (calc.team.goalsFor > calc.team.opponentGoals) totals.wins += 1;
    else if (calc.team.goalsFor < calc.team.opponentGoals) totals.losses += 1;
    else totals.ties += 1;

    for (const [id, stat] of Object.entries(calc.playerStats)) {
      const dest = playerTotals[id];
      if (!dest) continue;
      dest.goals += stat.goals;
      dest.assists += stat.assists;
      dest.points += stat.points;
      dest.ppGoals += stat.ppGoals;
      dest.ppAssists += stat.ppAssists;
      dest.ppPoints += stat.ppPoints;
      dest.shGoals += stat.shGoals;
      dest.shAssists += stat.shAssists;
      dest.pim += stat.pim;
    }
    for (const line of calc.goalieLines) {
      const dest = playerTotals[line.goalieId];
      if (!dest) continue;
      dest.goalieMinutes += line.minutes;
      dest.goalieShotsAgainst += line.shotsAgainst;
      dest.goalieGoalsAgainst += line.goalsAgainst;
      dest.goalieSaves += line.saves;
    }
  }

  totals.ppPct = percent(totals.ppGoals, totals.ppOpps);
  const kills = Math.max(0, totals.pkOpps - totals.pkGoalsAgainst);
  totals.pkPct = percent(kills, totals.pkOpps);
  totals.teamSavePct = savePct(totals.goalieSaves, totals.shotsAgainst);
  totals.teamGaa = totals.goalieMinutes ? ((totals.goalieGoalsAgainst / totals.goalieMinutes) * state.team.defaultGameMinutes).toFixed(2) : '';
  return { totals, playerTotals };
}

function gameWarnings(game) {
  const calc = calculateGame(game);
  const warnings = [];
  if (calc.team.ppGoals > calc.team.ppOpps) warnings.push({ level: 'bad', text: 'PP goals are greater than PP opportunities.' });
  if (calc.team.pkGoalsAgainst > calc.team.pkOpps) warnings.push({ level: 'bad', text: 'PP goals against are greater than PK opportunities.' });
  if (calc.team.goalieMinutes !== state.team.defaultGameMinutes) warnings.push({ level: 'warn', text: `Goalie minutes total ${calc.team.goalieMinutes}; expected ${state.team.defaultGameMinutes}. This may be fine if there was overtime, a shortened game, or an unusual goalie pull.` });
  if (calc.team.opponentGoals !== calc.team.opponentGoalsExpected) warnings.push({ level: 'warn', text: `Opponent score is ${calc.team.opponentGoals}, but goalie GA + empty-net GA totals ${calc.team.opponentGoalsExpected}.` });
  if (calc.team.goalsFor === 0 && calc.team.opponentGoals === 0) warnings.push({ level: 'warn', text: 'Final score is 0-0 based on current entries.' });
  if (!game.opponent?.trim()) warnings.push({ level: 'warn', text: 'Opponent is blank.' });
  if (!warnings.length) warnings.push({ level: 'good', text: 'No obvious entry issues found.' });
  return warnings;
}

function setRoute(route) {
  state.route = route;
  $$('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.route === route));
  if (route !== 'game') {
    state.currentDraft = null;
    state.editingId = null;
  }
  render();
}

function render() {
  updateHeader();
  if (!hasRoster() && state.route !== 'tools') return renderSetup();
  if (state.route === 'home') renderHome();
  else if (state.route === 'totals') renderTotals();
  else if (state.route === 'roster') renderRoster();
  else if (state.route === 'tools') renderTools();
  else if (state.route === 'game') renderGameForm();
}

function renderSetup() {
  clearAppHandlers();
  app.innerHTML = `
    <section class="card">
      <h2>Roster Setup Needed</h2>
      <p class="help">This public app does not contain player names. Import your private roster JSON from Files/iCloud Drive to begin. The roster is then stored locally on this device.</p>
      <div class="stack">
        <button id="importRosterFirstBtn" class="primary">Import Private Roster JSON</button>
        <button id="openToolsBtn" class="ghost">Open Export / Restore Tools</button>
      </div>
    </section>
    <section class="card">
      <h3>Privacy design</h3>
      <div class="notice">Only the blank app files should be uploaded to GitHub Pages. Keep the private roster import file out of the public repository.</div>
    </section>
  `;
  $('#importRosterFirstBtn').addEventListener('click', () => chooseJsonFile('roster'));
  $('#openToolsBtn').addEventListener('click', () => setRoute('tools'));
}

function renderHome() {
  clearAppHandlers();
  const { totals } = calculateSeason(state.games);
  const recent = state.games.slice(0, 8);
  app.innerHTML = `
    <section class="card">
      <div class="row between wrap">
        <div>
          <h2>${escapeHtml(state.team.name)}</h2>
          <p class="help">${escapeHtml(state.team.season)} · ${roster().length} players · local-first offline stat tracker</p>
        </div>
        <button id="newGameBtn" class="primary">New Game</button>
      </div>
    </section>
    <section class="kpi-grid">
      <div class="kpi"><div class="value">${totals.games}</div><div class="label">Games</div></div>
      <div class="kpi"><div class="value">${totals.wins}-${totals.losses}-${totals.ties}</div><div class="label">Record</div></div>
      <div class="kpi"><div class="value">${totals.ppPct || '—'}</div><div class="label">Power Play</div></div>
      <div class="kpi"><div class="value">${totals.pkPct || '—'}</div><div class="label">Penalty Kill</div></div>
    </section>
    <section class="card">
      <div class="row between">
        <h3>Saved Games</h3>
        ${localStorage.getItem(DRAFT_KEY) ? '<button id="resumeDraftBtn" class="secondary small">Resume Draft</button>' : ''}
      </div>
      <div class="list">
        ${recent.length ? recent.map(gameCard).join('') : '<p class="help">No games saved yet. Tap New Game to enter the first one.</p>'}
      </div>
    </section>
  `;
  $('#newGameBtn').addEventListener('click', () => {
    const existingDraft = localStorage.getItem(DRAFT_KEY);
    if (existingDraft && !confirm('There is an unsaved draft on this device. Start a new game anyway?')) return;
    state.currentDraft = newGame();
    state.editingId = null;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state.currentDraft));
    state.route = 'game';
    renderGameForm();
  });
  $('#resumeDraftBtn')?.addEventListener('click', () => {
    try {
      state.currentDraft = sanitizeGame(JSON.parse(localStorage.getItem(DRAFT_KEY)));
      state.editingId = null;
      state.route = 'game';
      renderGameForm();
    } catch {
      localStorage.removeItem(DRAFT_KEY);
      alert('The saved draft could not be loaded and was cleared.');
    }
  });
  $$('.edit-game').forEach(btn => btn.addEventListener('click', () => editExistingGame(btn.dataset.id)));
  $$('.export-game').forEach(btn => btn.addEventListener('click', () => exportGameCsv(btn.dataset.id)));
}

function gameCard(game) {
  const calc = calculateGame(game);
  const score = `${calc.team.goalsFor}-${calc.team.opponentGoals}`;
  const badgeClass = calc.team.goalsFor > calc.team.opponentGoals ? 'good' : calc.team.goalsFor < calc.team.opponentGoals ? 'bad' : 'warn';
  return `
    <article class="item">
      <div class="row between wrap">
        <div>
          <div class="item-title">${fmtDate(game.date)} ${game.homeAway === 'Home' ? 'vs' : game.homeAway === 'Away' ? '@' : 'vs'} ${escapeHtml(game.opponent || 'Opponent TBD')}</div>
          <div class="item-sub">${escapeHtml(game.eventName || game.location || 'No event/location')} · Shots ${calc.team.shotsFor}-${calc.team.shotsAgainst}</div>
        </div>
        <span class="badge ${badgeClass}">${score}</span>
      </div>
      <div class="row wrap">
        <span class="badge">PP ${calc.team.ppGoals}/${calc.team.ppOpps}</span>
        <span class="badge">PK ${Math.max(0, calc.team.pkOpps - calc.team.pkGoalsAgainst)}/${calc.team.pkOpps}</span>
        <button class="ghost small edit-game" data-id="${game.id}">Edit</button>
        <button class="ghost small export-game" data-id="${game.id}">Export Game</button>
      </div>
    </article>
  `;
}

function editExistingGame(id) {
  const game = state.games.find(g => g.id === id);
  if (!game) return;
  state.currentDraft = structuredClone(game);
  state.editingId = id;
  state.route = 'game';
  renderGameForm();
}

function renderTotals() {
  clearAppHandlers();
  const { totals, playerTotals } = calculateSeason(state.games);
  const sortedSkaters = skaters()
    .map(p => ({ ...p, stats: playerTotals[p.id] }))
    .sort((a, b) => b.stats.points - a.stats.points || b.stats.goals - a.stats.goals || a.jersey - b.jersey);
  const sortedGoalies = goalies()
    .map(p => ({ ...p, stats: playerTotals[p.id] }))
    .sort((a, b) => b.stats.goalieMinutes - a.stats.goalieMinutes || a.jersey - b.jersey);

  app.innerHTML = `
    <section class="card">
      <h2>Season Totals</h2>
      <div class="kpi-grid">
        <div class="kpi"><div class="value">${totals.goalsFor}-${totals.goalsAgainst}</div><div class="label">Goals</div></div>
        <div class="kpi"><div class="value">${totals.shotsFor}-${totals.shotsAgainst}</div><div class="label">Shots</div></div>
        <div class="kpi"><div class="value">${totals.ppGoals}/${totals.ppOpps}</div><div class="label">PP ${totals.ppPct || ''}</div></div>
        <div class="kpi"><div class="value">${Math.max(0, totals.pkOpps - totals.pkGoalsAgainst)}/${totals.pkOpps}</div><div class="label">PK ${totals.pkPct || ''}</div></div>
      </div>
    </section>
    <section class="card">
      <h3>Skater Totals</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Player</th><th class="num">G</th><th class="num">A</th><th class="num">PTS</th><th class="num">PPG</th><th class="num">PPA</th><th class="num">PPP</th><th class="num">PIM</th></tr></thead>
        <tbody>${sortedSkaters.map(p => `
          <tr><td>${p.jersey}</td><td>${escapeHtml(`${p.first} ${p.last}`)}</td><td class="num">${p.stats.goals}</td><td class="num">${p.stats.assists}</td><td class="num">${p.stats.points}</td><td class="num">${p.stats.ppGoals}</td><td class="num">${p.stats.ppAssists}</td><td class="num">${p.stats.ppPoints}</td><td class="num">${p.stats.pim}</td></tr>
        `).join('')}</tbody>
      </table></div>
    </section>
    <section class="card">
      <h3>Goalie Totals</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Goalie</th><th class="num">MIN</th><th class="num">SA</th><th class="num">GA</th><th class="num">SV</th><th class="num">SV%</th><th class="num">GAA</th></tr></thead>
        <tbody>${sortedGoalies.map(p => {
          const sv = p.stats.goalieSaves;
          const sa = p.stats.goalieShotsAgainst;
          const ga = p.stats.goalieGoalsAgainst;
          const min = p.stats.goalieMinutes;
          const gaa = min ? ((ga / min) * state.team.defaultGameMinutes).toFixed(2) : '';
          return `<tr><td>${p.jersey}</td><td>${escapeHtml(`${p.first} ${p.last}`)}</td><td class="num">${min}</td><td class="num">${sa}</td><td class="num">${ga}</td><td class="num">${sv}</td><td class="num">${savePct(sv, sa) || '—'}</td><td class="num">${gaa || '—'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>
  `;
}

function renderRoster() {
  clearAppHandlers();
  const forwards = roster().filter(p => p.position === 'Forward').sort((a, b) => a.jersey - b.jersey);
  const defense = roster().filter(p => p.position === 'Defense').sort((a, b) => a.jersey - b.jersey);
  const goalieList = goalies().sort((a, b) => a.jersey - b.jersey);
  const block = (title, players) => `
    <section class="card compact">
      <h3>${title}</h3>
      <div class="list">${players.length ? players.map(p => `<div class="item"><div class="row between"><span class="item-title">#${p.jersey} ${escapeHtml(`${p.first} ${p.last}`)}</span><span class="badge">${p.position}</span></div></div>`).join('') : '<p class="help">None.</p>'}</div>
    </section>`;
  app.innerHTML = `
    <section class="card">
      <div class="row between wrap">
        <div><h2>Roster</h2><p class="help">Loaded locally on this device. Not embedded in the public app files.</p></div>
        <button id="replaceRosterBtn" class="ghost small">Replace Roster</button>
      </div>
    </section>
    ${block('Forwards', forwards)}
    ${block('Defense', defense)}
    ${block('Goalies', goalieList)}
  `;
  $('#replaceRosterBtn').addEventListener('click', () => chooseJsonFile('roster'));
}

function renderTools() {
  clearAppHandlers();
  app.innerHTML = `
    <section class="card">
      <h2>Export & Backup</h2>
      <p class="help">Game and roster data are stored locally on this iPhone. Use JSON backups for restore. Use CSV exports for Google Sheets or Excel.</p>
      <div class="stack">
        <button id="importJson" class="primary">Import Roster or Backup JSON</button>
        <button id="exportBackupJson" class="ghost" ${hasRoster() ? '' : 'disabled'}>Export Full Backup JSON</button>
        <button id="exportRosterJson" class="ghost" ${hasRoster() ? '' : 'disabled'}>Export Roster JSON</button>
        <button id="exportSeasonCsv" class="secondary" ${hasRoster() ? '' : 'disabled'}>Export Season Player Totals CSV</button>
        <button id="exportGameLogCsv" class="secondary" ${hasRoster() ? '' : 'disabled'}>Export All Game Logs CSV</button>
      </div>
    </section>
    <section class="card">
      <h3>Device Safety</h3>
      <div class="warning">Because this is local-first, a full JSON backup is the safety copy. After entering games, save a backup to iCloud Drive, Google Drive, or Files.</div>
    </section>
    <section class="card">
      <h3>Privacy Reminder</h3>
      <p class="help">Upload only the public app folder to GitHub Pages. Do not upload your roster import JSON or any backup JSON that contains player names or stats.</p>
    </section>
  `;
  $('#importJson').addEventListener('click', () => chooseJsonFile('auto'));
  $('#exportSeasonCsv')?.addEventListener('click', exportSeasonTotalsCsv);
  $('#exportGameLogCsv')?.addEventListener('click', exportAllGameLogsCsv);
  $('#exportBackupJson')?.addEventListener('click', exportBackupJson);
  $('#exportRosterJson')?.addEventListener('click', exportRosterJson);
}

function renderGameForm() {
  if (!hasRoster()) return renderSetup();
  const game = sanitizeGame(state.currentDraft || newGame());
  state.currentDraft = game;
  const calc = calculateGame(game);
  const warnings = gameWarnings(game);
  const title = state.editingId ? 'Edit Game' : 'New Game';

  app.innerHTML = `
    <section class="card">
      <div class="row between wrap">
        <div>
          <h2>${title}</h2>
          <p class="help">Draft auto-saves on this device until you tap Save Game.</p>
        </div>
        <button id="cancelGameBtn" class="ghost">Close</button>
      </div>
    </section>

    <section class="card">
      <h3>Game Info</h3>
      <div class="grid two">
        <label>Date<input id="gameDate" type="date" value="${game.date || ''}"></label>
        <label>Home/Away/Neutral<select id="homeAway"><option ${game.homeAway === 'Home' ? 'selected' : ''}>Home</option><option ${game.homeAway === 'Away' ? 'selected' : ''}>Away</option><option ${game.homeAway === 'Neutral' ? 'selected' : ''}>Neutral</option></select></label>
        <label>Opponent<input id="opponent" value="${escapeAttr(game.opponent)}" placeholder="Opponent"></label>
        <label>Location<input id="location" value="${escapeAttr(game.location)}" placeholder="Rink / city"></label>
        <label>Event/Tournament<input id="eventName" value="${escapeAttr(game.eventName)}" placeholder="Optional"></label>
        <label>Opponent Goals<input id="opponentGoals" inputmode="numeric" type="number" min="0" value="${game.opponentGoals}"></label>
      </div>
    </section>

    <section class="card">
      <h3>Team & Special Teams</h3>
      <div class="kpi-grid">
        <div class="kpi"><div class="value">${calc.team.goalsFor}-${calc.team.opponentGoals}</div><div class="label">Score</div></div>
        <div class="kpi"><div class="value">${calc.team.shotsFor}-${calc.team.shotsAgainst}</div><div class="label">Shots</div></div>
        <div class="kpi"><div class="value">${calc.team.ppGoals}/${calc.team.ppOpps}</div><div class="label">PP ${calc.team.ppPct || ''}</div></div>
        <div class="kpi"><div class="value">${Math.max(0, calc.team.pkOpps - calc.team.pkGoalsAgainst)}/${calc.team.pkOpps}</div><div class="label">PK ${calc.team.pkPct || ''}</div></div>
      </div>
      <div class="grid two" style="margin-top:10px;">
        <label>PHC Shots on Goal<input id="shotsFor" inputmode="numeric" type="number" min="0" value="${game.shotsFor}"></label>
        <label>PP Opportunities<input id="ppOpps" inputmode="numeric" type="number" min="0" value="${game.ppOpps}"></label>
        <label>PK Opportunities / Times Shorthanded<input id="pkOpps" inputmode="numeric" type="number" min="0" value="${game.pkOpps}"></label>
        <label>PP Goals Against<input id="pkGoalsAgainst" inputmode="numeric" type="number" min="0" value="${game.pkGoalsAgainst}"></label>
        <label>Empty-net Goals Against<input id="emptyNetAgainst" inputmode="numeric" type="number" min="0" value="${game.emptyNetAgainst}"></label>
      </div>
      <p class="help">Opponent shots are calculated from individual goalie shots against.</p>
    </section>

    <section class="card">
      <div class="row between wrap"><h3>PHC Scoring Plays</h3><button id="addGoalBtn" class="secondary small">Add Goal</button></div>
      <div class="stack" id="goalsList">
        ${game.scoringPlays.length ? game.scoringPlays.map(goalRow).join('') : '<p class="help">Add one row per PHC goal. PP goals automatically create player and team power-play stats.</p>'}
      </div>
    </section>

    <section class="card">
      <h3>Goalie Stats</h3>
      <div class="row wrap" style="margin-bottom:10px;">
        ${goalies().map(g => `<button class="ghost small full-game-goalie" data-goalie="${g.id}">#${g.jersey} full game</button>`).join('')}
      </div>
      <div class="stack">
        ${game.goalieStats.map(goalieRow).join('')}
      </div>
      <p class="help">Minutes are whole numbers. Full regulation defaults to ${state.team.defaultGameMinutes} minutes.</p>
    </section>

    <section class="card">
      <div class="row between wrap"><h3>Penalties</h3><button id="addPenaltyBtn" class="secondary small">Add Penalty</button></div>
      <div class="stack" id="penaltiesList">
        ${game.penalties.length ? game.penalties.map(penaltyRow).join('') : '<p class="help">Add penalties if you want player PIM and special teams context.</p>'}
      </div>
    </section>

    <section class="card">
      <h3>Notes</h3>
      <textarea id="notes" placeholder="Optional game notes">${escapeHtml(game.notes || '')}</textarea>
    </section>

    <section class="card">
      <h3>Review</h3>
      <div class="review-list">${warnings.map(w => `<div class="review-item ${w.level}">${w.text}</div>`).join('')}</div>
      <div class="row wrap" style="margin-top:12px;">
        <button id="saveGameBtn" class="primary">Save Game</button>
        <button id="exportDraftBtn" class="secondary">Export Draft CSV</button>
        ${state.editingId ? '<button id="deleteGameBtn" class="danger">Delete Game</button>' : ''}
      </div>
    </section>
  `;

  bindGameFormEvents();
  autosaveDraft();
}

function goalRow(play, index) {
  return `
    <div class="goal-row" data-goal-id="${play.id}">
      <label>Strength<select class="goal-strength"><option ${play.strength === 'EV' ? 'selected' : ''}>EV</option><option ${play.strength === 'PP' ? 'selected' : ''}>PP</option><option ${play.strength === 'SH' ? 'selected' : ''}>SH</option><option ${play.strength === 'EN' ? 'selected' : ''}>EN</option></select></label>
      <label>Scorer<select class="goal-scorer">${optionsForSkaters(play.scorerId, true, 'Scorer')}</select></label>
      <label>Assist 1<select class="goal-assist1">${optionsForPlayers(play.assist1Id, true, 'No assist')}</select></label>
      <label>Assist 2<select class="goal-assist2">${optionsForPlayers(play.assist2Id, true, 'No assist')}</select></label>
      <button class="danger small remove-goal" data-id="${play.id}" aria-label="Remove goal ${index + 1}">Remove</button>
    </div>
  `;
}

function penaltyRow(pen) {
  return `
    <div class="penalty-row" data-penalty-id="${pen.id}">
      <label>Player<select class="pen-player">${optionsForPlayers(pen.playerId, true, 'Player')}</select></label>
      <label>Minutes<input class="pen-minutes" inputmode="numeric" type="number" min="0" value="${pen.minutes}"></label>
      <label>Infraction/Note<input class="pen-infraction" value="${escapeAttr(pen.infraction)}" placeholder="Optional"></label>
      <button class="danger small remove-penalty" data-id="${pen.id}">Remove</button>
    </div>
  `;
}

function goalieRow(line) {
  const goalie = playersById()[line.goalieId] || { jersey: '', first: 'Unknown', last: 'Goalie' };
  const sa = clampNonnegative(line.shotsAgainst);
  const ga = clampNonnegative(line.goalsAgainst);
  const saves = Math.max(0, sa - ga);
  return `
    <div class="goalie-row" data-goalie-id="${line.goalieId}">
      <div>
        <strong>#${goalie.jersey} ${escapeHtml(`${goalie.first} ${goalie.last}`)}</strong>
        <div class="item-sub">Saves ${saves} · SV% ${savePct(saves, sa) || '—'}</div>
      </div>
      <label>MIN<input class="goalie-minutes" inputmode="numeric" type="number" min="0" value="${line.minutes}"></label>
      <label>SA<input class="goalie-sa" inputmode="numeric" type="number" min="0" value="${line.shotsAgainst}"></label>
      <label>GA<input class="goalie-ga" inputmode="numeric" type="number" min="0" value="${line.goalsAgainst}"></label>
    </div>
  `;
}

function collectGameFromDom() {
  const old = state.currentDraft || newGame();
  const game = sanitizeGame({
    ...old,
    date: $('#gameDate')?.value || old.date,
    homeAway: $('#homeAway')?.value || old.homeAway,
    opponent: $('#opponent')?.value || '',
    location: $('#location')?.value || '',
    eventName: $('#eventName')?.value || '',
    opponentGoals: clampNonnegative($('#opponentGoals')?.value),
    shotsFor: clampNonnegative($('#shotsFor')?.value),
    ppOpps: clampNonnegative($('#ppOpps')?.value),
    pkOpps: clampNonnegative($('#pkOpps')?.value),
    pkGoalsAgainst: clampNonnegative($('#pkGoalsAgainst')?.value),
    emptyNetAgainst: clampNonnegative($('#emptyNetAgainst')?.value),
    notes: $('#notes')?.value || '',
    scoringPlays: $$('.goal-row').map(row => ({
      id: row.dataset.goalId,
      strength: $('.goal-strength', row).value,
      scorerId: $('.goal-scorer', row).value,
      assist1Id: $('.goal-assist1', row).value,
      assist2Id: $('.goal-assist2', row).value
    })),
    penalties: $$('.penalty-row').map(row => ({
      id: row.dataset.penaltyId,
      playerId: $('.pen-player', row).value,
      minutes: clampNonnegative($('.pen-minutes', row).value),
      infraction: $('.pen-infraction', row).value || ''
    })),
    goalieStats: $$('.goalie-row').map(row => ({
      goalieId: row.dataset.goalieId,
      minutes: clampNonnegative($('.goalie-minutes', row).value),
      shotsAgainst: clampNonnegative($('.goalie-sa', row).value),
      goalsAgainst: clampNonnegative($('.goalie-ga', row).value)
    }))
  });
  state.currentDraft = game;
  return game;
}

function autosaveDraft() {
  if (!state.currentDraft) return;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(state.currentDraft));
}

let inputDebounce;
function bindGameFormEvents() {
  $('#cancelGameBtn').addEventListener('click', () => {
    const ok = confirm('Close this game entry screen? Unsaved changes remain in the local draft until another draft is started or the game is saved.');
    if (!ok) return;
    setRoute('home');
  });

  app.oninput = () => {
    clearTimeout(inputDebounce);
    inputDebounce = setTimeout(() => {
      collectGameFromDom();
      autosaveDraft();
    }, 250);
  };

  app.onchange = () => {
    collectGameFromDom();
    autosaveDraft();
  };

  $('#addGoalBtn').addEventListener('click', () => {
    const game = collectGameFromDom();
    game.scoringPlays.push({ id: uid('goal'), strength: 'EV', scorerId: '', assist1Id: '', assist2Id: '' });
    state.currentDraft = game;
    renderGameForm();
  });

  $$('.remove-goal').forEach(btn => btn.addEventListener('click', () => {
    const game = collectGameFromDom();
    game.scoringPlays = game.scoringPlays.filter(p => p.id !== btn.dataset.id);
    state.currentDraft = game;
    renderGameForm();
  }));

  $('#addPenaltyBtn').addEventListener('click', () => {
    const game = collectGameFromDom();
    game.penalties.push({ id: uid('pen'), playerId: '', minutes: 2, infraction: '' });
    state.currentDraft = game;
    renderGameForm();
  });

  $$('.remove-penalty').forEach(btn => btn.addEventListener('click', () => {
    const game = collectGameFromDom();
    game.penalties = game.penalties.filter(p => p.id !== btn.dataset.id);
    state.currentDraft = game;
    renderGameForm();
  }));

  $$('.full-game-goalie').forEach(btn => btn.addEventListener('click', () => {
    const game = collectGameFromDom();
    game.goalieStats = game.goalieStats.map(line => ({ ...line, minutes: line.goalieId === btn.dataset.goalie ? state.team.defaultGameMinutes : 0 }));
    state.currentDraft = game;
    renderGameForm();
  }));

  $('#saveGameBtn').addEventListener('click', async () => {
    const game = collectGameFromDom();
    await putGame(game);
    localStorage.removeItem(DRAFT_KEY);
    state.currentDraft = null;
    state.editingId = null;
    await refreshGames();
    state.route = 'home';
    render();
  });

  $('#exportDraftBtn').addEventListener('click', () => {
    const game = collectGameFromDom();
    exportGameObjectCsv(game, `PHC_15U_${safeFilePart(game.date)}_${safeFilePart(game.opponent || 'draft')}_game_stats.csv`);
  });

  $('#deleteGameBtn')?.addEventListener('click', async () => {
    if (!state.editingId) return;
    if (!confirm('Delete this saved game? This cannot be undone unless you have a JSON backup.')) return;
    await deleteGame(state.editingId);
    localStorage.removeItem(DRAFT_KEY);
    await refreshGames();
    state.route = 'home';
    render();
  });
}

function gameCsvRows(game) {
  const calc = calculateGame(game);
  const rows = [[
    'Game ID', 'Date', 'Opponent', 'Home/Away', 'Location', 'Event', 'Team Goals', 'Opponent Goals', 'Shots For', 'Shots Against', 'Shot Differential',
    'PP Goals', 'PP Opportunities', 'PP%', 'PK Goals Against', 'PK Opportunities', 'PK%', 'Empty Net GA',
    'Jersey', 'First', 'Last', 'Position', 'G', 'A', 'PTS', 'PPG', 'PPA', 'PPP', 'SHG', 'SHA', 'PIM',
    'Goalie Minutes', 'Goalie SA', 'Goalie GA', 'Goalie Saves', 'Goalie SV%', 'Goalie GAA', 'Notes'
  ]];
  for (const p of roster().slice().sort((a, b) => a.jersey - b.jersey)) {
    const ps = calc.playerStats[p.id];
    const gl = calc.goalieLines.find(line => line.goalieId === p.id);
    rows.push([
      calc.game.id, calc.game.date, calc.game.opponent, calc.game.homeAway, calc.game.location, calc.game.eventName,
      calc.team.goalsFor, calc.team.opponentGoals, calc.team.shotsFor, calc.team.shotsAgainst, calc.team.shotDifferential,
      calc.team.ppGoals, calc.team.ppOpps, calc.team.ppPct, calc.team.pkGoalsAgainst, calc.team.pkOpps, calc.team.pkPct, calc.team.emptyNetAgainst,
      p.jersey, p.first, p.last, p.position, ps.goals, ps.assists, ps.points, ps.ppGoals, ps.ppAssists, ps.ppPoints, ps.shGoals, ps.shAssists, ps.pim,
      gl ? gl.minutes : '', gl ? gl.shotsAgainst : '', gl ? gl.goalsAgainst : '', gl ? gl.saves : '', gl ? gl.savePct : '', gl ? gl.gaa : '', calc.game.notes || ''
    ]);
  }
  return rows;
}

function exportGameObjectCsv(game, filename) {
  downloadOrShare(filename, 'text/csv', rowsToCsv(gameCsvRows(game)));
}

function exportGameCsv(id) {
  const game = state.games.find(g => g.id === id);
  if (!game) return;
  exportGameObjectCsv(game, `PHC_15U_${safeFilePart(game.date)}_${safeFilePart(game.opponent || 'game')}_stats.csv`);
}

function exportAllGameLogsCsv() {
  const rows = [[
    'Game ID', 'Date', 'Opponent', 'Home/Away', 'Location', 'Event', 'Team Goals', 'Opponent Goals', 'Shots For', 'Shots Against', 'Shot Differential',
    'PP Goals', 'PP Opportunities', 'PP%', 'PK Goals Against', 'PK Opportunities', 'PK%', 'Empty Net GA', 'Team SV%', 'Team GAA', 'Notes'
  ]];
  for (const game of state.games.slice().reverse()) {
    const calc = calculateGame(game);
    rows.push([
      game.id, game.date, game.opponent, game.homeAway, game.location, game.eventName, calc.team.goalsFor, calc.team.opponentGoals,
      calc.team.shotsFor, calc.team.shotsAgainst, calc.team.shotDifferential, calc.team.ppGoals, calc.team.ppOpps, calc.team.ppPct,
      calc.team.pkGoalsAgainst, calc.team.pkOpps, calc.team.pkPct, calc.team.emptyNetAgainst, calc.team.teamSavePct, calc.team.teamGaa, game.notes || ''
    ]);
  }
  downloadOrShare(`PHC_15U_${state.team.season}_game_log.csv`, 'text/csv', rowsToCsv(rows));
}

function exportSeasonTotalsCsv() {
  const { totals, playerTotals } = calculateSeason(state.games);
  const rows = [[
    'Jersey', 'First', 'Last', 'Position', 'G', 'A', 'PTS', 'PPG', 'PPA', 'PPP', 'SHG', 'SHA', 'PIM', 'Goalie Minutes', 'Goalie SA', 'Goalie GA', 'Goalie Saves', 'Goalie SV%', 'Goalie GAA'
  ]];
  for (const p of roster().slice().sort((a, b) => a.jersey - b.jersey)) {
    const s = playerTotals[p.id];
    const goalieSave = savePct(s.goalieSaves, s.goalieShotsAgainst);
    const goalieGaa = s.goalieMinutes ? ((s.goalieGoalsAgainst / s.goalieMinutes) * state.team.defaultGameMinutes).toFixed(2) : '';
    rows.push([p.jersey, p.first, p.last, p.position, s.goals, s.assists, s.points, s.ppGoals, s.ppAssists, s.ppPoints, s.shGoals, s.shAssists, s.pim, s.goalieMinutes, s.goalieShotsAgainst, s.goalieGoalsAgainst, s.goalieSaves, goalieSave, goalieGaa]);
  }
  rows.push([]);
  rows.push(['TEAM', '', '', '', totals.goalsFor, '', '', totals.ppGoals, '', '', '', '', '', totals.goalieMinutes, totals.shotsAgainst, totals.goalieGoalsAgainst, totals.goalieSaves, totals.teamSavePct, totals.teamGaa]);
  downloadOrShare(`PHC_15U_${state.team.season}_player_totals.csv`, 'text/csv', rowsToCsv(rows));
}

function exportBackupJson() {
  const backup = {
    app: 'PHC 15U Stats',
    type: 'backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    team: state.team,
    roster: roster(),
    games: state.games
  };
  downloadOrShare(`PHC_15U_${state.team.season}_backup_${todayISO()}.json`, 'application/json', JSON.stringify(backup, null, 2));
}

function exportRosterJson() {
  const payload = {
    app: 'PHC 15U Stats',
    type: 'roster',
    version: 2,
    exportedAt: new Date().toISOString(),
    team: state.team,
    roster: roster()
  };
  downloadOrShare(`PHC_15U_${state.team.season}_roster_import.json`, 'application/json', JSON.stringify(payload, null, 2));
}

function chooseJsonFile(mode = 'auto') {
  state.pendingImportMode = mode;
  jsonFileInput.value = '';
  jsonFileInput.click();
}

async function importRosterPayload(payload) {
  const nextRoster = sanitizeRoster(Array.isArray(payload) ? payload : payload.roster);
  if (!nextRoster.length) throw new Error('No players found in this roster file.');
  if (state.games.length && !confirm(`Replace the current roster with ${nextRoster.length} players? Existing saved games are not deleted, but player IDs must match for old stats to line up.`)) return;
  state.team = { ...DEFAULT_TEAM, ...(payload.team || {}) };
  state.roster = nextRoster;
  localStorage.removeItem(DRAFT_KEY);
  state.currentDraft = null;
  state.editingId = null;
  await saveConfig();
  render();
  alert(`Roster imported: ${nextRoster.length} players.`);
}

async function importBackupPayload(payload) {
  if (!Array.isArray(payload.games)) throw new Error('Backup file does not contain a games array.');
  const nextRoster = sanitizeRoster(payload.roster || state.roster);
  if (!nextRoster.length) throw new Error('Backup does not contain a usable roster.');
  if (!confirm(`Restore ${payload.games.length} games and ${nextRoster.length} rostered players from this backup? This replaces all saved games currently on this device.`)) return;
  state.team = { ...DEFAULT_TEAM, ...(payload.team || {}) };
  state.roster = nextRoster;
  await saveConfig();
  await clearGames();
  for (const game of payload.games) await putGame(sanitizeGame(game));
  localStorage.removeItem(DRAFT_KEY);
  state.currentDraft = null;
  state.editingId = null;
  await refreshGames();
  state.route = 'home';
  render();
  alert('Backup restored.');
}

jsonFileInput.addEventListener('change', async () => {
  const file = jsonFileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const mode = state.pendingImportMode;
    if (mode === 'roster') await importRosterPayload(payload);
    else if (payload.type === 'backup' || Array.isArray(payload.games)) await importBackupPayload(payload);
    else if (payload.type === 'roster' || Array.isArray(payload.roster) || Array.isArray(payload)) await importRosterPayload(payload);
    else throw new Error('JSON file was not recognized as a roster or backup.');
  } catch (err) {
    alert(`Could not import file: ${err.message}`);
  } finally {
    state.pendingImportMode = 'auto';
    jsonFileInput.value = '';
  }
});

$('#modalClose').addEventListener('click', closeModal);
$('#installHelpBtn').addEventListener('click', () => openModal(`
  <h2>Install on iPhone</h2>
  <p>Upload only the public app files to an HTTPS static host such as GitHub Pages. Then open the app link in Safari, tap Share, and tap Add to Home Screen.</p>
  <p class="help">After installation, import the private roster JSON from Files or iCloud Drive. Firefox can remain your default browser.</p>
`));

$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => setRoute(btn.dataset.route)));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

(async function boot() {
  try {
    db = await initDb();
    await loadConfig();
    await refreshGames();
    render();
  } catch (err) {
    app.innerHTML = `<section class="card"><h2>Storage Error</h2><p class="error">The local database could not open: ${escapeHtml(err.message)}</p></section>`;
  }
})();
