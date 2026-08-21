require('dotenv').config();
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const db = require('./db');

const OLD_DB_PATH = path.join(__dirname, 'data', 'app.db');

function readAll(SQLdb, table) {
  const stmt = SQLdb.prepare(`SELECT * FROM ${table}`);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function cleanRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v === undefined ? null : v;
  }
  return out;
}

async function bulkInsert(client, table, cols, rows) {
  if (!rows.length) return 0;
  const CHUNK = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const placeholders = chunk.map((row, ri) => {
      const ph = cols.map((c, ci) => `$${ri * cols.length + ci + 1}`);
      cols.forEach((c) => values.push(row[c] === undefined ? null : row[c]));
      return `(${ph.join(', ')})`;
    }).join(', ');
    const res = await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders} ON CONFLICT (id) DO NOTHING`,
      values
    );
    inserted += res.rowCount;
  }
  return inserted;
}

async function fixSequence(client, table) {
  await client.query(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`
  );
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is missing in .env');
    process.exit(1);
  }
  if (!fs.existsSync(OLD_DB_PATH)) {
    console.error(`Old database not found at ${OLD_DB_PATH}`);
    process.exit(1);
  }

  console.log('[1/4] Reading old SQLite database...');
  const SQL = await initSqlJs();
  const SQLdb = new SQL.Database(new Uint8Array(fs.readFileSync(OLD_DB_PATH)));

  const sessions = readAll(SQLdb, 'exam_sessions').map(cleanRow);
  const allEntries = readAll(SQLdb, 'exam_entries').map(cleanRow);
  const allRoutines = readAll(SQLdb, 'routine_entries').map(cleanRow);
  const allUploads = readAll(SQLdb, 'uploads').map(cleanRow);

  // Skip orphaned rows whose parent session was deleted (old SQLite did not enforce FK)
  const sessionIds = new Set(sessions.map((s) => s.id));
  const entries = allEntries.filter((r) => sessionIds.has(r.session_id));
  const routines = allRoutines.filter((r) => sessionIds.has(r.session_id));
  const uploads = allUploads.filter((r) => sessionIds.has(r.session_id));

  console.log(`   sessions=${sessions.length}`);
  console.log(`   exam_entries: total=${allEntries.length}, valid=${entries.length}, skipped_orphaned=${allEntries.length - entries.length}`);
  console.log(`   routine_entries: total=${allRoutines.length}, valid=${routines.length}`);
  console.log(`   uploads: total=${allUploads.length}, valid=${uploads.length}`);

  console.log('[2/4] Ensuring Neon schema...');
  await db.ensureSchema();

  console.log('[3/4] Migrating data to Neon...');
  await db.transaction(async (client) => {
    await bulkInsert(client, 'exam_sessions',
      ['id', 'name', 'term', 'status', 'created_at'], sessions);
    await bulkInsert(client, 'exam_entries',
      ['id', 'session_id', 'course_code', 'course_title', 'teacher_initial', 'section', 'exam_date', 'time_slot', 'room', 'roll_start', 'roll_end', 'source', 'created_at'], entries);
    await bulkInsert(client, 'routine_entries',
      ['id', 'session_id', 'course_code', 'course_title', 'section', 'teacher_initial', 'created_at'], routines);
    await bulkInsert(client, 'uploads',
      ['id', 'session_id', 'type', 'original_filename', 'parsed_row_count', 'status', 'uploaded_at'], uploads);

    await fixSequence(client, 'exam_sessions');
    await fixSequence(client, 'exam_entries');
    await fixSequence(client, 'routine_entries');
    await fixSequence(client, 'uploads');
  });

  console.log('[4/4] Verifying Neon counts...');
  const neonSessions = (await db.get('SELECT COUNT(*) c FROM exam_sessions')).c;
  const neonEntries = (await db.get('SELECT COUNT(*) c FROM exam_entries')).c;
  const neonRoutines = (await db.get('SELECT COUNT(*) c FROM routine_entries')).c;
  const neonUploads = (await db.get('SELECT COUNT(*) c FROM uploads')).c;

  console.log('');
  console.log('================ RESULT ================');
  console.log(`exam_sessions : sqlite=${sessions.length}  ->  neon=${neonSessions}`);
  console.log(`exam_entries  : sqlite=${entries.length}  ->  neon=${neonEntries}`);
  console.log(`routine_entries: sqlite=${routines.length}  ->  neon=${neonRoutines}`);
  console.log(`uploads       : sqlite=${uploads.length}  ->  neon=${neonUploads}`);
  console.log('========================================');

  const ok =
    Number(neonSessions) >= sessions.length &&
    Number(neonEntries) >= entries.length &&
    Number(neonRoutines) >= routines.length &&
    Number(neonUploads) >= uploads.length;
  console.log(ok ? 'MIGRATION OK ✓' : 'MIGRATION MISMATCH ✗');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
