let currentSessionId = null;

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Not authenticated');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ---------------- AUTH ----------------
function showLogin() {
  document.getElementById('login-shell').style.display = 'block';
  document.getElementById('dashboard-shell').style.display = 'none';
  document.getElementById('logout-link').style.display = 'none';
}
function showDashboard() {
  document.getElementById('login-shell').style.display = 'none';
  document.getElementById('dashboard-shell').style.display = 'block';
  document.getElementById('logout-link').style.display = 'inline';
  loadSessions();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    showDashboard();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/admin/logout', { method: 'POST' });
  showLogin();
});

async function checkAuth() {
  const res = await fetch('/api/admin/me');
  const data = await res.json();
  if (data.loggedIn) showDashboard(); else showLogin();
}

// ---------------- SESSIONS ----------------
async function loadSessions() {
  const sessions = await api('/api/admin/sessions');
  const list = document.getElementById('sessions-list');
  if (!sessions.length) {
    list.innerHTML = '<p class="hint">No sessions yet — create one above (e.g. "Midterm Fall 2026").</p>';
    return;
  }
  list.innerHTML = sessions.map((s) => `
    <div class="session-item">
      <div>
        <strong>${s.name}</strong>
        <div class="meta">${s.entry_count} rows · created ${new Date(s.created_at).toLocaleDateString()}</div>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="status-pill ${s.status}">${s.status}</span>
        <button class="secondary" data-open="${s.id}" data-name="${s.name}" data-status="${s.status}">Open</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => openWorkspace(btn.dataset.open, btn.dataset.name, btn.dataset.status));
  });
}

document.getElementById('new-session-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-session-name');
  const name = nameInput.value.trim();
  if (!name) return toast('Enter a session name first', true);
  await api('/api/admin/sessions', { method: 'POST', body: JSON.stringify({ name }) });
  nameInput.value = '';
  toast('Session created');
  loadSessions();
});

function openWorkspace(id, name, status) {
  currentSessionId = id;
  document.getElementById('workspace-panel').style.display = 'block';
  document.getElementById('workspace-title').textContent = name;
  const pill = document.getElementById('workspace-status');
  pill.textContent = status;
  pill.className = 'status-pill ' + status;
  loadEntries();
  document.getElementById('workspace-panel').scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('publish-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  await api(`/api/admin/sessions/${currentSessionId}/publish`, { method: 'POST' });
  toast('Published — students can now see this schedule');
  loadSessions();
  const pill = document.getElementById('workspace-status');
  pill.textContent = 'published'; pill.className = 'status-pill published';
});
document.getElementById('unpublish-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  await api(`/api/admin/sessions/${currentSessionId}/unpublish`, { method: 'POST' });
  toast('Unpublished');
  loadSessions();
  const pill = document.getElementById('workspace-status');
  pill.textContent = 'draft'; pill.className = 'status-pill draft';
});
document.getElementById('delete-session-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  if (!confirm('Delete this whole session and all its rows? This cannot be undone.')) return;
  await api(`/api/admin/sessions/${currentSessionId}`, { method: 'DELETE' });
  currentSessionId = null;
  document.getElementById('workspace-panel').style.display = 'none';
  toast('Session deleted');
  loadSessions();
});

// ---------------- UPLOAD ----------------
const dropzone = document.getElementById('dropzone');
const pdfInput = document.getElementById('pdf-input');

['dragover', 'dragenter'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadPdf(file);
});
pdfInput.addEventListener('change', () => {
  if (pdfInput.files[0]) uploadPdf(pdfInput.files[0]);
});

async function uploadPdf(file) {
  if (!currentSessionId) return toast('Open a session first', true);
  const type = document.getElementById('upload-type').value;
  const statusEl = document.getElementById('upload-status');
  statusEl.textContent = 'Uploading & parsing…';

  const formData = new FormData();
  formData.append('pdf', file);
  formData.append('type', type);

  try {
    const res = await fetch(`/api/admin/sessions/${currentSessionId}/upload`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    let statusMsg = `Parsed ${data.parsedCount} row(s) from ${data.totalLines} text items.`;
    if (data.unparsedCount > 0) {
      statusMsg += ` ${data.unparsedCount} line(s) could not be auto-matched.`;
    }
    if (data.sections && data.sections.length > 0) {
      statusMsg += `\nSections found: ${data.sections.length} (${data.sections.slice(0, 8).join(', ')}${data.sections.length > 8 ? '...' : ''})`;
    }
    if (data.dates && data.dates.length > 0) {
      statusMsg += `\nDates: ${data.dates.join(', ')}`;
    }
    if (data.slots && data.slots.length > 0) {
      statusMsg += `\nSlots: ${data.slots.join(', ')}`;
    }
    statusEl.textContent = statusMsg;
    statusEl.style.whiteSpace = 'pre-line';
    toast(`Parsed ${data.parsedCount} rows — review below`);
    loadEntries();
  } catch (err) {
    statusEl.textContent = '';
    toast(err.message, true);
  }
}

// ---------------- REVIEW & FIX GRID ----------------
async function loadEntries() {
  if (!currentSessionId) return;
  const rows = await api(`/api/admin/sessions/${currentSessionId}/entries`);
  document.getElementById('entry-count').textContent = `${rows.length} row(s)`;
  const tbody = document.getElementById('entries-tbody');
  tbody.innerHTML = rows.map((r) => rowHtml(r)).join('');
  attachRowHandlers();
}

const FIELDS = ['course_code', 'course_title', 'teacher_initial', 'section', 'exam_date', 'time_slot', 'room', 'roll_start', 'roll_end'];

function rowHtml(r) {
  return `
    <tr data-id="${r.id}">
      ${FIELDS.map((f) => `<td><input data-field="${f}" value="${r[f] != null ? String(r[f]).replace(/"/g, '&quot;') : ''}"></td>`).join('')}
      <td><button class="secondary" data-delete="${r.id}" style="padding:6px 10px; font-size:12px;">✕</button></td>
    </tr>
  `;
}

let saveTimers = {};
function attachRowHandlers() {
  document.querySelectorAll('#entries-tbody input').forEach((input) => {
    input.addEventListener('change', () => scheduleSave(input.closest('tr')));
  });
  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/admin/entries/${btn.dataset.delete}`, { method: 'DELETE' });
      btn.closest('tr').remove();
      toast('Row removed');
    });
  });
}

function scheduleSave(tr) {
  const id = tr.dataset.id;
  clearTimeout(saveTimers[id]);
  saveTimers[id] = setTimeout(async () => {
    const payload = {};
    FIELDS.forEach((f) => {
      const val = tr.querySelector(`[data-field="${f}"]`).value.trim();
      payload[f] = (f === 'roll_start' || f === 'roll_end') ? (val ? parseInt(val, 10) : null) : (val || null);
    });
    try {
      await api(`/api/admin/entries/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Saved');
    } catch (err) {
      toast(err.message, true);
    }
  }, 500);
}

document.getElementById('add-row-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  const created = await api(`/api/admin/sessions/${currentSessionId}/entries`, {
    method: 'POST',
    body: JSON.stringify({ section: 'NEW' }),
  });
  loadEntries();
});

document.getElementById('refresh-entries-btn').addEventListener('click', loadEntries);

checkAuth();
