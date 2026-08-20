const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'app.db');

let _db = null;
let _dirty = false;
let _saveTimer = null;

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_dirty || !_db) return;
    _dirty = false;
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 300);
}

function flushSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!_dirty || !_db) return;
  _dirty = false;
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function convertNamedParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('@') || k.startsWith('$') || k.startsWith(':')) {
      out[k] = v;
    } else {
      out['@' + k] = v;
    }
  }
  return out;
}

function bindArgs(rawArgs) {
  if (rawArgs.length === 0) return undefined;
  if (rawArgs.length === 1 && rawArgs[0] !== null && typeof rawArgs[0] === 'object' && !Array.isArray(rawArgs[0])) {
    return convertNamedParams(rawArgs[0]);
  }
  return rawArgs.flat();
}

function createStatement(sql) {
  return {
    get(...rawArgs) {
      const params = bindArgs(rawArgs);
      const stmt = _db.prepare(sql);
      try {
        if (params !== undefined) stmt.bind(params);
        if (stmt.step()) return stmt.getAsObject();
        return undefined;
      } finally { stmt.free(); }
    },

    all(...rawArgs) {
      const params = bindArgs(rawArgs);
      const stmt = _db.prepare(sql);
      try {
        if (params !== undefined) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally { stmt.free(); }
    },

    run(...rawArgs) {
      const params = bindArgs(rawArgs);
      if (params !== undefined) {
        _db.run(sql, params);
      } else {
        _db.run(sql);
      }
      const changes = _db.getRowsModified();
      let lastInsertRowid = 0;
      try {
        const res = _db.exec('SELECT last_insert_rowid()');
        if (res.length > 0 && res[0].values.length > 0) lastInsertRowid = res[0].values[0][0];
      } catch (_) {}
      scheduleSave();
      return { changes, lastInsertRowid };
    }
  };
}

const wrapper = {
  prepare(sql) { return createStatement(sql); },

  transaction(fn) {
    return (...args) => {
      _db.run('BEGIN TRANSACTION');
      try {
        fn(...args);
        _db.run('COMMIT');
      } catch (e) {
        _db.run('ROLLBACK');
        throw e;
      }
      scheduleSave();
    };
  },

  exec(sql) {
    _db.exec(sql);
    scheduleSave();
  }
};

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(new Uint8Array(buf));
  } else {
    _db = new SQL.Database();
  }

  _db.run(`
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  term TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exam_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  course_code TEXT,
  course_title TEXT,
  teacher_initial TEXT,
  section TEXT NOT NULL,
  exam_date TEXT,
  time_slot TEXT,
  room TEXT,
  roll_start INTEGER,
  roll_end INTEGER,
  source TEXT DEFAULT 'seatplan',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routine_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES exam_sessions(id) ON DELETE CASCADE,
  course_code TEXT,
  course_title TEXT,
  section TEXT,
  teacher_initial TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES exam_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  original_filename TEXT,
  parsed_row_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'parsed',
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

  try {
    _db.run('CREATE INDEX IF NOT EXISTS idx_entries_section ON exam_entries(section)');
    _db.run('CREATE INDEX IF NOT EXISTS idx_entries_session ON exam_entries(session_id)');
  } catch (_) {}

  try {
    _db.run('ALTER TABLE exam_entries ADD COLUMN teacher_initial TEXT');
  } catch (_) {}

  scheduleSave();
  return wrapper;
}

module.exports = initDb();
