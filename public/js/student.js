const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let mergedExams = [];
let selectedDateKey = null;
let countdownInterval = null;

/* ── Date helpers (DB stores DD-MM-YYYY) ── */
function parseDate(dateStr) {
  if (!dateStr) return null;
  let m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function dateKey(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

function fmtDateFull(d) {
  if (!d) return 'Date TBD';
  return `${DAYS_FULL[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/* ── Slot helpers ── */
function parseSlot(timeSlot) {
  const out = { letter: '', start: '', end: '' };
  if (!timeSlot) return out;
  const lm = timeSlot.match(/Slot\s+([A-Z])/i);
  if (lm) out.letter = lm[1].toUpperCase();
  const tm = timeSlot.match(/\(([^)]+)\)/);
  if (tm) {
    const parts = tm[1].split('-');
    if (parts.length >= 2) {
      out.start = parts[0].trim();
      out.end = parts[parts.length - 1].trim();
    }
  }
  return out;
}

function slotStartMinutes(slot) {
  const m = (slot.start || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return 9 * 60;
  let h = +m[1];
  const min = +m[2];
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

/* ── Room display: bare room numbers belong to the KT building ── */
function formatRoom(room) {
  return /^[0-9]/.test(room) ? 'KT-' + room : room;
}

/* ── Merge rows: same date+slot+course → one exam with rooms array ── */
function mergeExams(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.exam_date || ''}|${r.time_slot || ''}|${(r.course_code || '').toUpperCase()}`;
    if (!map.has(key)) {
      map.set(key, {
        exam_date: r.exam_date || '',
        time_slot: r.time_slot || '',
        course_code: r.course_code || '',
        course_title: r.course_title || '',
        teacher_initial: r.teacher_initial || '',
        rooms: [],
        seatMap: {}
      });
    }
    const exam = map.get(key);
    if (r.room && !exam.rooms.includes(r.room)) {
      exam.rooms.push(r.room);
      exam.seatMap[r.room] = r.seats || null;
    }
  }
  const exams = [...map.values()];
  exams.sort((a, b) => {
    const da = parseDate(a.exam_date);
    const db = parseDate(b.exam_date);
    if (da && db && da.getTime() !== db.getTime()) return da - db;
    return slotStartMinutes(parseSlot(a.time_slot)) - slotStartMinutes(parseSlot(b.time_slot));
  });
  return exams;
}

/* ── Section combobox ── */
let allSections = [];
let comboActiveIndex = -1;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function normalizeSection(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function setComboError(show) {
  document.getElementById('section').classList.toggle('invalid', show);
  document.getElementById('section-error').style.display = show ? 'block' : 'none';
}

function closeComboList() {
  document.getElementById('section-list').classList.remove('open');
  comboActiveIndex = -1;
}

function selectSection(value) {
  const input = document.getElementById('section');
  input.value = value;
  setComboError(false);
  closeComboList();
}

function renderComboList(query) {
  const list = document.getElementById('section-list');
  const q = normalizeSection(query);
  const matches = q ? allSections.filter((s) => normalizeSection(s).includes(q)) : allSections;

  if (!allSections.length) {
    list.innerHTML = '<div class="combo-empty">No published schedules yet</div>';
  } else if (!matches.length) {
    list.innerHTML = `<div class="combo-empty">No section matches &ldquo;${escapeHtml(query)}&rdquo;</div>`;
  } else {
    list.innerHTML = matches.map((s, i) =>
      `<div class="combo-item${i === comboActiveIndex ? ' active' : ''}" role="option" data-value="${s}">${s}</div>`
    ).join('');
  }
  list.classList.add('open');

  list.querySelectorAll('.combo-item').forEach((item) => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectSection(item.dataset.value);
    });
  });
}

function moveComboActive(dir) {
  const items = [...document.querySelectorAll('#section-list .combo-item')];
  if (!items.length) return;
  comboActiveIndex += dir;
  if (comboActiveIndex < 0) comboActiveIndex = items.length - 1;
  if (comboActiveIndex >= items.length) comboActiveIndex = 0;
  items.forEach((el, i) => el.classList.toggle('active', i === comboActiveIndex));
  items[comboActiveIndex].scrollIntoView({ block: 'nearest' });
}

function wireCombobox() {
  const input = document.getElementById('section');
  const list = document.getElementById('section-list');

  input.addEventListener('focus', () => renderComboList(input.value));
  input.addEventListener('input', () => {
    setComboError(false);
    comboActiveIndex = -1;
    renderComboList(input.value);
  });

  input.addEventListener('keydown', (e) => {
    const open = list.classList.contains('open');
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      moveComboActive(1);
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      moveComboActive(-1);
    } else if (e.key === 'Enter' && open) {
      if (comboActiveIndex >= 0) {
        e.preventDefault();
        const item = list.querySelector('.combo-item.active');
        if (item) selectSection(item.dataset.value);
      } else {
        const exact = allSections.find((s) => s.toUpperCase() === input.value.trim().toUpperCase());
        if (exact) {
          e.preventDefault();
          selectSection(exact);
        }
      }
    } else if (e.key === 'Escape') {
      closeComboList();
    }
  });

  input.addEventListener('blur', () => setTimeout(closeComboList, 120));
}

async function loadSections() {
  try {
    const res = await fetch('/api/sections');
    allSections = await res.json();
    if (!allSections.length) {
      document.getElementById('section').placeholder = 'No published schedules yet';
    }
  } catch (e) {
    document.getElementById('section').placeholder = 'Failed to load sections';
  }
  wireCombobox();
}

/* ── Day picker ── */
function renderDayPicker(exams) {
  const picker = document.getElementById('day-picker');
  const byDate = new Map();
  for (const e of exams) {
    const d = parseDate(e.exam_date);
    if (!d) continue;
    const key = dateKey(d);
    if (!byDate.has(key)) byDate.set(key, d);
  }
  const dates = [...byDate.entries()].sort((a, b) => a[1] - b[1]);

  if (!dates.length) {
    picker.innerHTML = '';
    return;
  }

  picker.innerHTML = dates.map(([key, d]) => `
    <button type="button" class="day-card${key === selectedDateKey ? ' active' : ''}" data-key="${key}">
      <span class="date-num">${d.getDate()}</span>
      <span class="date-week">${DAYS_SHORT[d.getDay()]}</span>
    </button>
  `).join('');

  picker.querySelectorAll('.day-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedDateKey = btn.dataset.key;
      renderDayPicker(mergedExams);
      renderExamsForDate();
    });
  });
}

/* ── Exam cards for selected date ── */
function renderExamsForDate() {
  const body = document.getElementById('results-body');
  const dayExams = mergedExams.filter((e) => {
    const d = parseDate(e.exam_date);
    return d && dateKey(d) === selectedDateKey;
  });

  if (!dayExams.length) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#128197;</div>
        <div class="empty-state-text">No exams on this date.</div>
      </div>`;
    return;
  }

  body.innerHTML = dayExams.map((e) => {
    const slot = parseSlot(e.time_slot);
    const timeText = slot.start ? (slot.end ? `${slot.start} &ndash; ${slot.end}` : slot.start) : 'Time TBD';
    const slotClass = slot.letter ? ` slot-${slot.letter.toLowerCase()}` : '';

    return `
      <article class="exam-card">
        <div class="exam-card-top">
          <span class="course-badge">${e.course_code || 'TBD'}</span>
          ${slot.letter ? `<span class="slot-pill${slotClass}">Slot ${slot.letter}</span>` : ''}
        </div>
        <h3 class="exam-title">${e.course_title || e.course_code || 'Exam'}</h3>
        <div class="exam-divider"></div>
        <div class="exam-meta">
          <div class="meta-row">
            <span class="meta-icon">&#128339;</span>
            <span>${timeText}</span>
          </div>
          <div class="meta-row">
            <span class="meta-icon">&#128100;</span>
            <span>${e.teacher_initial || 'TBD'}</span>
          </div>
        </div>
        <p class="rooms-label">Your Rooms</p>
        <div class="room-chips">
          ${(e.rooms.length ? e.rooms : ['TBD']).map((r) => {
            const seats = e.seatMap ? e.seatMap[r] : null;
            return `<span class="room-chip">${r === 'TBD' ? r : formatRoom(r)}${seats ? ` <span class="chip-seats">(${seats})</span>` : ''}</span>`;
          }).join('')}
        </div>
      </article>
    `;
  }).join('');
}

/* ── Countdown hero ── */
function startCountdown(exams) {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;

  const hero = document.getElementById('countdown-hero');
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const upcoming = exams
    .map((e) => ({ e, d: parseDate(e.exam_date) }))
    .filter((x) => x.d && x.d >= todayStart)
    .sort((a, b) => a.d - b.d);

  if (!upcoming.length) {
    hero.style.display = 'none';
    return;
  }

  const next = upcoming[0];
  const slot = parseSlot(next.e.time_slot);
  const target = new Date(next.d.getFullYear(), next.d.getMonth(), next.d.getDate(), 0, 0, 0);
  target.setMinutes(slotStartMinutes(slot));

  document.getElementById('countdown-course').textContent =
    next.e.course_title || next.e.course_code || 'Upcoming Exam';
  document.getElementById('countdown-meta').textContent =
    `${fmtDateFull(next.d)}${slot.start ? ` &middot; ${slot.start}${slot.end ? ' &ndash; ' + slot.end : ''}` : ''}`;

  const timerEl = document.getElementById('countdown-timer');

  function tick() {
    const diff = target.getTime() - Date.now();
    if (diff <= 0) {
      timerEl.innerHTML = '<div class="timer-block"><span class="timer-num" style="font-size:18px;">NOW</span><span class="timer-unit">Good luck!</span></div>';
      if (countdownInterval) clearInterval(countdownInterval);
      return;
    }
    const totalSec = Math.floor(diff / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    timerEl.innerHTML = `
      <div class="timer-block"><span class="timer-num">${days}</span><span class="timer-unit">Days</span></div>
      <div class="timer-block"><span class="timer-num">${String(hours).padStart(2, '0')}</span><span class="timer-unit">Hours</span></div>
      <div class="timer-block"><span class="timer-num">${String(mins).padStart(2, '0')}</span><span class="timer-unit">Mins</span></div>
      <div class="timer-block"><span class="timer-num">${String(secs).padStart(2, '0')}</span><span class="timer-unit">Secs</span></div>
    `;
  }

  hero.style.display = 'block';
  tick();
  countdownInterval = setInterval(tick, 1000);
}

/* ── Render everything after search ── */
function renderResults(rows) {
  const panel = document.getElementById('results-panel');
  panel.style.display = 'block';

  if (!rows.length) {
    mergedExams = [];
    document.getElementById('day-picker').innerHTML = '';
    document.getElementById('results-body').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#128269;</div>
        <div class="empty-state-text">No exam schedule found for this section yet.<br>Please check the section or ask admin to publish it.</div>
      </div>`;
    document.getElementById('countdown-hero').style.display = 'none';
    return;
  }

  mergedExams = mergeExams(rows);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const upcomingKey = mergedExams
    .map((e) => parseDate(e.exam_date))
    .filter((d) => d && d >= todayStart)
    .sort((a, b) => a - b)[0];
  const firstKey = mergedExams
    .map((e) => parseDate(e.exam_date))
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  selectedDateKey = dateKey(upcomingKey || firstKey);

  renderDayPicker(mergedExams);
  renderExamsForDate();
  startCountdown(mergedExams);
}

/* ── Search submit ── */
document.getElementById('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = document.getElementById('section').value.trim().toUpperCase();
  const section = allSections.find((s) => s.toUpperCase() === raw);
  if (!section) {
    setComboError(true);
    return;
  }

  const btn = e.target.querySelector('.search-btn');
  const btnText = btn.querySelector('.search-btn-text');
  btn.disabled = true;
  btnText.textContent = 'Searching...';

  try {
    const res = await fetch(`/api/search?section=${encodeURIComponent(section)}`);
    const rows = await res.json();
    renderResults(rows);
  } catch (err) {
    document.getElementById('results-panel').style.display = 'block';
    document.getElementById('results-body').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#9888;&#65039;</div>
        <div class="empty-state-text">Something went wrong. Please try again.</div>
      </div>`;
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Find My Exams';
  }
});

loadSections();
