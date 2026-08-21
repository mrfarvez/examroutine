const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { parsePdfBuffer } = require('./parser/pdfParser');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please';

function resolvePublicDir() {
  const candidates = [
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public'),
    path.join(process.cwd(), 'public')
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) || candidates[0];
}

function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieSession({ name: 'sess', secret: SESSION_SECRET, maxAge: 24 * 60 * 60 * 1000 }));
  app.use(express.static(resolvePublicDir()));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

  // ---------- bootstrap default admin (from env) ----------
  (async () => {
    try {
      const username = process.env.ADMIN_USERNAME || 'admin';
      const password = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = bcrypt.hashSync(password, 10);
      const existing = await db.get('SELECT * FROM admin_users WHERE username = $1', [username]);
      if (!existing) {
        await db.run('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', [username, hash]);
        console.log(`[setup] Created admin user "${username}".`);
      } else if (!bcrypt.compareSync(password, existing.password_hash)) {
        await db.run('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, existing.id]);
        console.log(`[setup] Updated password for admin "${username}" from env.`);
      }
    } catch (e) {
      console.error('[setup] Admin bootstrap failed:', e.message);
    }
  })();

  function requireAuth(req, res, next) {
    if (req.session && req.session.adminId) return next();
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // ================= AUTH =================
  app.post('/api/admin/login', ah(async (req, res) => {
    const { username, password } = req.body;
    const user = await db.get('SELECT * FROM admin_users WHERE username = $1', [username]);
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
    const rows = await db.query(`
      SELECT es.*, COUNT(ee.id) AS entry_count
      FROM exam_sessions es
      LEFT JOIN exam_entries ee ON ee.session_id = es.id
      GROUP BY es.id
      ORDER BY es.created_at DESC
    `);
    res.json(rows.map((r) => ({ ...r, entry_count: Number(r.entry_count) })));
  }));

  app.post('/api/admin/sessions', requireAuth, ah(async (req, res) => {
    const { name, term } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = await db.insertReturningId(
      "INSERT INTO exam_sessions (name, term, status) VALUES ($1, $2, 'draft') RETURNING id",
      [name, term || null]
    );
    res.json({ id });
  }));

  app.post('/api/admin/sessions/:id/publish', requireAuth, ah(async (req, res) => {
    await db.run("UPDATE exam_sessions SET status = 'published' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }));

  app.post('/api/admin/sessions/:id/unpublish', requireAuth, ah(async (req, res) => {
    await db.run("UPDATE exam_sessions SET status = 'draft' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }));

  app.delete('/api/admin/sessions/:id', requireAuth, ah(async (req, res) => {
    await db.run('DELETE FROM exam_sessions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ================= UPLOAD + PARSE =================
  app.post('/api/admin/sessions/:id/upload', requireAuth, upload.single('pdf'), ah(async (req, res) => {
    const sessionId = req.params.id;
    const type = (req.body.type || 'seatplan').toLowerCase();
    const session = await db.get('SELECT * FROM exam_sessions WHERE id = $1', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (field name: pdf)' });

    try {
      const { totalLines, parsedRows, unparsedLines, debug } = await parsePdfBuffer(req.file.buffer, type);

      await db.transaction(async (client) => {
        for (const r of parsedRows) {
          await client.query(`
            INSERT INTO exam_entries (session_id, course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [sessionId, r.course_code || null, r.course_title || null, r.teacher_initial || null, r.section, r.exam_date || null, r.time_slot || null, r.room || null, r.roll_start || null, r.roll_end || null, r.source || 'seatplan']);
        }
      });

      await db.run(`
        INSERT INTO uploads (session_id, type, original_filename, parsed_row_count, status)
        VALUES ($1, $2, $3, $4, 'parsed')
      `, [sessionId, type, req.file.originalname, parsedRows.length]);

      const uniqueSections = [...new Set(parsedRows.map((r) => r.section).filter(Boolean))];
      const uniqueDates = [...new Set(parsedRows.map((r) => r.exam_date).filter(Boolean))];
      const uniqueSlots = [...new Set(parsedRows.map((r) => r.time_slot).filter(Boolean))];

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
      await db.run(`
        INSERT INTO uploads (session_id, type, original_filename, parsed_row_count, status)
        VALUES ($1, $2, $3, 0, 'failed')
      `, [sessionId, type, req.file.originalname]).catch(() => {});
      res.status(500).json({ error: 'Failed to parse PDF: ' + err.message });
    }
  }));

  // ================= REVIEW & FIX (edit parsed rows) =================
  app.get('/api/admin/sessions/:id/entries', requireAuth, ah(async (req, res) => {
    const rows = await db.query('SELECT * FROM exam_entries WHERE session_id = $1 ORDER BY exam_date, time_slot, section', [req.params.id]);
    res.json(rows);
  }));

  app.post('/api/admin/sessions/:id/entries', requireAuth, ah(async (req, res) => {
    const { course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end } = req.body;
    if (!section) return res.status(400).json({ error: 'section is required' });
    const id = await db.insertReturningId(`
      INSERT INTO exam_entries (session_id, course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual')
      RETURNING id
    `, [req.params.id, course_code || null, course_title || null, teacher_initial || null, section, exam_date || null, time_slot || null, room || null, roll_start || null, roll_end || null]);
    res.json({ id });
  }));

  app.put('/api/admin/entries/:entryId', requireAuth, ah(async (req, res) => {
    const { course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end } = req.body;
    await db.run(`
      UPDATE exam_entries SET course_code=$1, course_title=$2, teacher_initial=$3, section=$4, exam_date=$5, time_slot=$6, room=$7, roll_start=$8, roll_end=$9
      WHERE id=$10
    `, [course_code || null, course_title || null, teacher_initial || null, section, exam_date || null, time_slot || null, room || null, roll_start || null, roll_end || null, req.params.entryId]);
    res.json({ ok: true });
  }));

  app.delete('/api/admin/entries/:entryId', requireAuth, ah(async (req, res) => {
    await db.run('DELETE FROM exam_entries WHERE id = $1', [req.params.entryId]);
    res.json({ ok: true });
  }));

  // ================= PUBLIC: sections list + student search =================
  app.get('/', (req, res) => {
    res.sendFile(path.join(resolvePublicDir(), 'index.html'));
  });

  app.get('/api/sections', ah(async (req, res) => {
    const rows = await db.query(`
      SELECT DISTINCT ee.section FROM exam_entries ee
      JOIN exam_sessions es ON es.id = ee.session_id
      WHERE es.status = 'published'
      ORDER BY ee.section
    `);
    res.json(rows.map((r) => r.section));
  }));

  app.get('/api/search', ah(async (req, res) => {
    const { section, roll } = req.query;
    if (!section) return res.status(400).json({ error: 'section query param is required' });

    const rows = await db.query(`
      SELECT ee.* FROM exam_entries ee
      JOIN exam_sessions es ON es.id = ee.session_id
      WHERE es.status = 'published' AND UPPER(ee.section) = UPPER($1)
      ORDER BY ee.exam_date, ee.time_slot
    `, [section]);

    const rollNum = roll ? parseInt(roll, 10) : null;
    const results = rows.filter((r) => {
      if (r.roll_start && r.roll_end && rollNum) {
        return rollNum >= r.roll_start && rollNum <= r.roll_end;
      }
      return !r.roll_start || !r.roll_end;
    });

    res.json(results);
  }));

  // ================= 404 + ERROR HANDLER =================
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
