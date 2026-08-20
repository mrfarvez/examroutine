const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parsePdfBuffer } = require('./parser/pdfParser');

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please';

async function createApp() {
  const db = await require('./db');

  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieSession({ name: 'sess', secret: SESSION_SECRET, maxAge: 24 * 60 * 60 * 1000 }));
  app.use(express.static(path.join(__dirname, 'public')));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

  const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- bootstrap default admin (from .env) ----------
  (async function ensureAdmin() {
    try {
      const username = process.env.ADMIN_USERNAME || 'admin';
      const password = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = bcrypt.hashSync(password, 10);
      const existing = await db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
      if (!existing) {
        await db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run(username, hash);
        console.log(`[setup] Created admin user "${username}".`);
      } else if (!bcrypt.compareSync(password, existing.password_hash)) {
        await db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
        console.log(`[setup] Updated password for admin "${username}" from .env.`);
      }
    } catch (err) {
      console.error('[setup] Admin bootstrap failed:', err.message);
    }
  })();

  function requireAuth(req, res, next) {
    if (req.session && req.session.adminId) return next();
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // ================= AUTH =================
  app.post('/api/admin/login', ah(async (req, res) => {
    const { username, password } = req.body;
    const user = await db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.adminId = user.id;
    res.json({ ok: true, username: user.username });
  }));

  app.post('/api/admin/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => {
    if (!req.session || !req.session.adminId) return res.json({ loggedIn: false });
    res.json({ loggedIn: true });
  });

  // ================= EXAM SESSIONS =================
  app.get('/api/admin/sessions', requireAuth, ah(async (req, res) => {
    const sessions = await db.prepare('SELECT * FROM exam_sessions ORDER BY created_at DESC').all();
    const withCounts = [];
    for (const s of sessions) {
      const count = await db.prepare('SELECT COUNT(*) c FROM exam_entries WHERE session_id = ?').get(s.id);
      withCounts.push({ ...s, entry_count: count.c });
    }
    res.json(withCounts);
  }));

  app.post('/api/admin/sessions', requireAuth, ah(async (req, res) => {
    const { name, term } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const info = await db.prepare('INSERT INTO exam_sessions (name, term, status) VALUES (?, ?, ?)').run(name, term || null, 'draft');
    res.json({ id: info.lastInsertRowid });
  }));

  app.post('/api/admin/sessions/:id/publish', requireAuth, ah(async (req, res) => {
    await db.prepare("UPDATE exam_sessions SET status = 'published' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/admin/sessions/:id/unpublish', requireAuth, ah(async (req, res) => {
    await db.prepare("UPDATE exam_sessions SET status = 'draft' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  }));

  app.delete('/api/admin/sessions/:id', requireAuth, ah(async (req, res) => {
    await db.prepare('DELETE FROM exam_entries WHERE session_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM uploads WHERE session_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM exam_sessions WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  }));

  // ================= UPLOAD + PARSE =================
  const INSERT_ENTRY_SQL = `
    INSERT INTO exam_entries (session_id, course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end, source)
    VALUES (@session_id, @course_code, @course_title, @teacher_initial, @section, @exam_date, @time_slot, @room, @roll_start, @roll_end, @source)
  `;

  app.post('/api/admin/sessions/:id/upload', requireAuth, upload.single('pdf'), ah(async (req, res) => {
    const sessionId = req.params.id;
    const type = (req.body.type || 'seatplan').toLowerCase();
    const session = await db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (field name: pdf)' });

    try {
      const { totalLines, parsedRows, unparsedLines, debug } = await parsePdfBuffer(req.file.buffer, type);

      await db.batch(parsedRows.map((r) => ({
        sql: INSERT_ENTRY_SQL,
        args: { session_id: sessionId, ...r }
      })));

      await db.prepare(`
        INSERT INTO uploads (session_id, type, original_filename, parsed_row_count, status)
        VALUES (?, ?, ?, ?, 'parsed')
      `).run(sessionId, type, req.file.originalname, parsedRows.length);

      const uniqueSections = [...new Set(parsedRows.map(r => r.section).filter(Boolean))];
      const uniqueDates = [...new Set(parsedRows.map(r => r.exam_date).filter(Boolean))];
      const uniqueSlots = [...new Set(parsedRows.map(r => r.time_slot).filter(Boolean))];

      res.json({
        ok: true,
        totalLines,
        parsedCount: parsedRows.length,
        unparsedCount: unparsedLines.length,
        unparsedSample: unparsedLines.slice(0, 25),
        sections: uniqueSections.sort(),
        dates: uniqueDates.sort(),
        slots: uniqueSlots.sort(),
        debug: debug || null
      });
    } catch (err) {
      console.error(err);
      await db.prepare(`
        INSERT INTO uploads (session_id, type, original_filename, parsed_row_count, status)
        VALUES (?, ?, ?, 0, 'failed')
      `).run(sessionId, type, req.file.originalname);
      res.status(500).json({ error: 'Failed to parse PDF: ' + err.message });
    }
  }));

  // ================= REVIEW & FIX (edit parsed rows) =================
  app.get('/api/admin/sessions/:id/entries', requireAuth, ah(async (req, res) => {
    const rows = await db.prepare('SELECT * FROM exam_entries WHERE session_id = ? ORDER BY exam_date, time_slot, section').all(req.params.id);
    res.json(rows);
  }));

  app.post('/api/admin/sessions/:id/entries', requireAuth, ah(async (req, res) => {
    const { course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end } = req.body;
    if (!section) return res.status(400).json({ error: 'section is required' });
    const info = await db.prepare(`
      INSERT INTO exam_entries (session_id, course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(req.params.id, course_code || null, course_title || null, teacher_initial || null, section, exam_date || null, time_slot || null, room || null, roll_start || null, roll_end || null);
    res.json({ id: info.lastInsertRowid });
  }));

  app.put('/api/admin/entries/:entryId', requireAuth, ah(async (req, res) => {
    const { course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end } = req.body;
    await db.prepare(`
      UPDATE exam_entries SET course_code=?, course_title=?, teacher_initial=?, section=?, exam_date=?, time_slot=?, room=?, roll_start=?, roll_end=?
      WHERE id=?
    `).run(course_code || null, course_title || null, teacher_initial || null, section, exam_date || null, time_slot || null, room || null, roll_start || null, roll_end || null, req.params.entryId);
    res.json({ ok: true });
  }));

  app.delete('/api/admin/entries/:entryId', requireAuth, ah(async (req, res) => {
    await db.prepare('DELETE FROM exam_entries WHERE id = ?').run(req.params.entryId);
    res.json({ ok: true });
  }));

  // ================= PUBLIC: sections list + student search =================
  app.get('/api/sections', ah(async (req, res) => {
    const rows = await db.prepare(`
      SELECT DISTINCT ee.section FROM exam_entries ee
      JOIN exam_sessions es ON es.id = ee.session_id
      WHERE es.status = 'published'
      ORDER BY ee.section
    `).all();
    res.json(rows.map((r) => r.section));
  }));

  app.get('/api/search', ah(async (req, res) => {
    const { section, roll } = req.query;
    if (!section) return res.status(400).json({ error: 'section query param is required' });

    const rows = await db.prepare(`
      SELECT ee.* FROM exam_entries ee
      JOIN exam_sessions es ON es.id = ee.session_id
      WHERE es.status = 'published' AND UPPER(ee.section) = UPPER(?)
      ORDER BY ee.exam_date, ee.time_slot
    `).all(section);

    const rollNum = roll ? parseInt(roll, 10) : null;
    const results = rows.filter((r) => {
      if (r.roll_start && r.roll_end && rollNum) {
        return rollNum >= r.roll_start && rollNum <= r.roll_end;
      }
      return !r.roll_start || !r.roll_end;
    });

    res.json(results);
  }));

  // ================= ERROR HANDLER =================
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return app;
}

module.exports = { createApp };
