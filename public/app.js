const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countsEl = document.getElementById('counts');
const template = document.getElementById('entry-template');
const addForm = document.getElementById('add-form');
const addBtn = document.getElementById('add-btn');
const addError = document.getElementById('add-error');
const accountInput = document.getElementById('account');
const passwordInput = document.getElementById('password');

const tiles = new Map(); // id -> { el, img, entry, receivedAt }

const STATE_TEXT = {
  queued: 'QUEUED',
  starting: 'STARTING',
  running: 'RUNNING',
  'killed-inactive': 'INACTIVE KILLED',
  error: 'ERROR',
};

function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function formatTime(epoch) {
  return new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shortUrl(raw) {
  try {
    const url = new URL(raw);
    return url.pathname + url.search + url.hash;
  } catch {
    return raw || '';
  }
}

function createTile(entry) {
  const el = template.content.firstElementChild.cloneNode(true);
  el.querySelector('.remove-btn').addEventListener('click', async () => {
    await fetch(`/api/sessions/${entry.id}`, { method: 'DELETE' });
  });
  el.querySelector('.rerun-btn').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      await fetch(`/api/sessions/${entry.id}/rerun`, { method: 'POST' });
    } finally {
      ev.target.disabled = false;
    }
  });
  const check = el.querySelector('.select-check');
  check.addEventListener('change', () => updateSelectionButtons());
  return {
    el,
    check,
    img: el.querySelector('.screen'),
    consoleLog: el.querySelector('.console-log'),
    entry,
    receivedAt: Date.now(),
  };
}

function appendConsoleLine(tile, level, message) {
  const line = document.createElement('div');
  line.className = 'line';
  line.dataset.level = level;
  line.textContent = message;
  tile.consoleLog.appendChild(line);
  while (tile.consoleLog.children.length > 200) {
    tile.consoleLog.removeChild(tile.consoleLog.firstChild);
  }
  tile.consoleLog.scrollTop = tile.consoleLog.scrollHeight;
}

function updateTile(tile, entry) {
  tile.entry = entry;
  tile.receivedAt = Date.now();
  const { el } = tile;
  el.dataset.state = entry.state;

  el.querySelector('.entry-label').textContent = entry.label;
  el.querySelector('.entry-account').textContent = entry.account;

  const stateEl = el.querySelector('.entry-state');
  stateEl.textContent =
    entry.state === 'queued'
      ? `QUEUED #${entry.queuePosition}`
      : STATE_TEXT[entry.state] || entry.state.toUpperCase();

  // Rerunning a queued entry is a no-op, so only offer it once it has left the queue.
  el.querySelector('.rerun-btn').style.display = entry.state === 'queued' ? 'none' : '';
  tile.check.style.visibility = entry.state === 'queued' ? 'hidden' : '';
  if (entry.state === 'queued') tile.check.checked = false;

  const removeBtn = el.querySelector('.remove-btn');
  removeBtn.textContent =
    entry.state === 'running' || entry.state === 'starting'
      ? 'Close'
      : entry.state === 'queued'
        ? 'Cancel'
        : 'Remove';

  const urlEl = el.querySelector('.entry-url');
  if (entry.state === 'running') {
    urlEl.textContent = shortUrl(entry.url);
    urlEl.className = `entry-url ${entry.onActivePath ? 'on-path' : 'off-path'}`;
  } else if (entry.state === 'killed-inactive') {
    urlEl.textContent = `closed ${formatTime(entry.killedAt)} — ${entry.killReason || 'no console output'}`;
    urlEl.className = 'entry-url';
  } else {
    urlEl.textContent = '';
    urlEl.className = 'entry-url';
  }

  el.querySelector('.entry-error').textContent = entry.error || '';
  el.querySelector('.viewer').style.display =
    entry.state === 'running' || entry.state === 'starting' ? '' : 'none';
  if (entry.state !== 'running' && entry.state !== 'starting') {
    tile.img.removeAttribute('src');
  }

  updateIdle(tile);
}

function updateIdle(tile) {
  const { entry } = tile;
  const quietEl = tile.el.querySelector('.entry-quiet');
  if (entry.state !== 'running' || !entry.consoleIdleLimitMs || entry.consoleIdleMs === null) {
    quietEl.textContent = '';
    return;
  }
  const quiet = entry.consoleIdleMs + (Date.now() - tile.receivedAt);
  quietEl.textContent = `quiet ${formatDuration(quiet)} / ${formatDuration(entry.consoleIdleLimitMs)}`;
  quietEl.className = `entry-quiet ${quiet > entry.consoleIdleLimitMs / 2 ? 'off-path' : 'on-path'}`;
}

function renderList(payload) {
  const seen = new Set();
  for (const entry of payload.entries) {
    seen.add(entry.id);
    let tile = tiles.get(entry.id);
    if (!tile) {
      tile = createTile(entry);
      tiles.set(entry.id, tile);
      listEl.appendChild(tile.el);
    }
    updateTile(tile, entry);
  }
  for (const [id, tile] of tiles) {
    if (!seen.has(id)) {
      tile.el.remove();
      tiles.delete(id);
    }
  }

  const running = payload.entries.filter((e) => e.state === 'running' || e.state === 'starting').length;
  const queued = payload.entries.filter((e) => e.state === 'queued').length;
  countsEl.textContent = `${running} / ${payload.maxActive} running · ${queued} queued`;
  emptyEl.style.display = payload.entries.length ? 'none' : '';
  updateSelectionButtons();
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addError.textContent = '';
  addBtn.disabled = true;
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountInput.value, password: passwordInput.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add');
    accountInput.value = '';
    passwordInput.value = '';
  } catch (err) {
    addError.textContent = err.message;
  } finally {
    addBtn.disabled = false;
  }
});

// Selection for batch rerun. History rows are rebuilt on every update, so their
// ticks live in a Set; session cards persist, so their checkbox holds the state.
const selectedHistory = new Set();
const rerunSelectedBtn = document.getElementById('rerun-selected');
const selectAllBtn = document.getElementById('select-all');
const rerunHistoryBtn = document.getElementById('rerun-history');
const selectAllHistory = document.getElementById('select-all-history');

function selectableTiles() {
  return [...tiles.values()].filter((t) => t.entry.state !== 'queued');
}

function selectedTileIds() {
  return selectableTiles().filter((t) => t.check.checked).map((t) => t.entry.id);
}

function updateSelectionButtons() {
  const n = selectedTileIds().length;
  rerunSelectedBtn.textContent = `Rerun selected (${n})`;
  rerunSelectedBtn.disabled = n === 0;
  const all = selectableTiles();
  selectAllBtn.textContent = all.length && all.every((t) => t.check.checked) ? 'Select none' : 'Select all';

  const h = selectedHistory.size;
  rerunHistoryBtn.textContent = `Rerun selected (${h})`;
  rerunHistoryBtn.disabled = h === 0;
}

selectAllBtn.addEventListener('click', () => {
  const all = selectableTiles();
  const tickAll = !all.every((t) => t.check.checked);
  for (const t of all) t.check.checked = tickAll;
  updateSelectionButtons();
});

async function postRerun(url, ids, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!data.requeued) alert('Nothing to rerun (already queued, or no stored password).');
    return data.requeued;
  } finally {
    updateSelectionButtons();
  }
}

rerunSelectedBtn.addEventListener('click', async () => {
  const ids = selectedTileIds();
  const running = selectableTiles().filter(
    (t) => t.check.checked && (t.entry.state === 'running' || t.entry.state === 'starting')
  ).length;
  if (running && !confirm(`${running} selected session(s) are running now and will be restarted. Continue?`)) return;
  await postRerun('/api/sessions/rerun', ids, rerunSelectedBtn);
  for (const t of tiles.values()) t.check.checked = false;
  updateSelectionButtons();
});

rerunHistoryBtn.addEventListener('click', async () => {
  const requeued = await postRerun('/api/history/rerun', [...selectedHistory], rerunHistoryBtn);
  if (requeued) alert(`Queued ${requeued} account(s). Accounts that already have a session were skipped.`);
  selectedHistory.clear();
  for (const box of historyBody.querySelectorAll('input[type=checkbox]')) box.checked = false;
  selectAllHistory.checked = false;
  updateSelectionButtons();
});

let historyItems = [];
selectAllHistory.addEventListener('change', () => {
  selectedHistory.clear();
  if (selectAllHistory.checked) {
    for (const item of historyItems) if (item.canRerun) selectedHistory.add(item.id);
  }
  renderHistory(historyItems);
});

const historyBody = document.getElementById('history-body');
const historyEmpty = document.getElementById('history-empty');

const RESULT_TEXT = {
  'idle-timeout': 'Closed — idle too long',
  'console-timeout': 'Closed — no console output',
  'courses-done': 'Closed — all courses done',
  'requeued-low-memory': 'Requeued — low memory',
  'script-failed': 'Rerun — script failed',
  'closed-by-user': 'Closed by user',
  cancelled: 'Cancelled (never started)',
  error: 'Error',
  'server-stopped': 'Server stopped',
};

function formatDateTime(epoch) {
  if (!epoch) return '—';
  return new Date(epoch).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderHistory(items) {
  historyItems = items;
  const ids = new Set(items.map((i) => i.id));
  for (const id of selectedHistory) if (!ids.has(id)) selectedHistory.delete(id);
  historyBody.replaceChildren();
  for (const item of items) {
    const row = document.createElement('tr');
    row.dataset.result = item.result;

    const checkTd = document.createElement('td');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.disabled = !item.canRerun;
    check.checked = selectedHistory.has(item.id);
    check.addEventListener('change', () => {
      if (check.checked) selectedHistory.add(item.id);
      else selectedHistory.delete(item.id);
      updateSelectionButtons();
    });
    checkTd.appendChild(check);
    row.appendChild(checkTd);

    const result = RESULT_TEXT[item.result] || item.result;
    const cells = [
      item.label,
      item.account,
      item.error ? `${result}: ${item.error}` : result,
      formatDateTime(item.startedAt),
      formatDateTime(item.endedAt),
      item.startedAt ? formatDuration(item.endedAt - item.startedAt) : '—',
      item.lastPath || '—',
    ];
    for (const [i, text] of cells.entries()) {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 2) td.className = 'result';
      if (i === 6) td.className = 'path';
      row.appendChild(td);
    }

    const actionTd = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = 'Rerun';
    btn.disabled = !item.canRerun;
    btn.title = item.canRerun ? `Run ${item.account} again` : 'No stored password for this account';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/history/${item.id}/rerun`, { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || 'Could not rerun');
          btn.disabled = false;
        }
      } catch {
        btn.disabled = false;
      }
    });
    actionTd.appendChild(btn);
    row.appendChild(actionTd);

    historyBody.appendChild(row);
  }
  historyEmpty.style.display = items.length ? 'none' : '';
  updateSelectionButtons();
}

document.getElementById('clear-history').addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  await fetch('/api/history', { method: 'DELETE' });
});

function connectSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'list') {
      renderList(msg);
    } else if (msg.type === 'history') {
      renderHistory(msg.entries);
    } else if (msg.type === 'frame') {
      const tile = tiles.get(msg.id);
      if (tile) tile.img.src = `data:image/jpeg;base64,${msg.data}`;
    } else if (msg.type === 'resources') {
      const el = document.getElementById('resources');
      el.textContent = `RAM ${msg.memMB}MB · load ${msg.load}${msg.blockedBy ? ` · holding queue (${msg.blockedBy})` : ''}`;
      el.className = `resources ${msg.blockedBy ? 'off-path' : ''}`;
    } else if (msg.type === 'console') {
      const tile = tiles.get(msg.id);
      if (tile) appendConsoleLine(tile, msg.level, msg.message);
    }
  };
  ws.onclose = () => setTimeout(connectSocket, 2000);
}

setInterval(() => {
  for (const tile of tiles.values()) updateIdle(tile);
}, 1000);

connectSocket();
