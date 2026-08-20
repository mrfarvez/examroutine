const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LOCAL_DB = path.join(DATA_DIR, 'local.db');
const DB_URL = process.env.TURSO_DATABASE_URL || `file:${LOCAL_DB}`;
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || undefined;

const client = createClient({ url: DB_URL, authToken: AUTH_TOKEN });

function toRow(columns, row) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
  return obj;
}

function normalizeArgs(rawArgs) {
  if (!rawArgs || rawArgs.length === 0) return [];
  if (rawArgs.length === 1 && rawArgs[0] !== null && typeof rawArgs[0] === 'object' && !Array.isArray(rawArgs[0])) {
    const out = {};
    for (const [k, v] of Object.entries(rawArgs[0])) {
      out[k.startsWith('@') || k.startsWith('$') || k.startsWith(':') ? k : '@' + k] = v;
    }
    return out;
  }
  return rawArgs.flat();
}

function createStatement(sql) {
  return {
    async get(...rawArgs) {
      const res = await client.execute({ sql, args: normalizeArgs(rawArgs) });
      if (!res.rows.length) return undefined;
      return toRow(res.columns, res.rows[0]);
    },
    async all(...rawArgs) {
      const res = await client.execute({ sql, args: normalizeArgs(rawArgs) });
      return res.rows.map((r) => toRow(res.columns, r));
    },
    async run(...rawArgs) {
      const res = await client.execute({ sql, args: normalizeArgs(rawArgs) });
      return {
        changes: Number(res.rowsAffected || 0),
        lastInsertRowid: Number(res.lastInsertRowid || 0)
      };
    }
  };
}

const wrapper = {
  prepare(sql) { return createStatement(sql); },

  async batch(statements) {
    if (!statements.length) return;
    const stmts = statements.map((st) => ({
      sql: st.sql,
      args: Array.isArray(st.args) ? st.args.flat() : normalizeArgs([st.args])
    }));
    await client.batch(stmts, 'write');
  },

  async exec(sql) {
    await client.executeMultiple(sql);
  },

  _client: client
};

async function initDb() {
  await client.executeMultiple(`
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
    await client.execute('CREATE INDEX IF NOT EXISTS idx_entries_section ON exam_entries(section)');
    await client.execute('CREATE INDEX IF NOT EXISTS idx_entries_session ON exam_entries(session_id)');
  } catch (_) {}

  console.log(`[db] Connected: ${DB_URL.startsWith('libsql://') ? 'Turso cloud' : 'local file'}`);
  return wrapper;
}

module.exports = initDb();
