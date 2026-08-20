// Optional: run `npm run seed` to populate a sample published session
// so you can see the student search working immediately without
// uploading a real PDF first.
require('dotenv').config();

(async () => {
  const db = await require('./db');

  const info = await db.prepare(`INSERT INTO exam_sessions (name, term, status) VALUES (?, ?, 'published')`)
    .run('Midterm Exam (Sample)', 'Fall 2026');
  const sessionId = info.lastInsertRowid;

  const rows = [
    ['CSE332', 'Software Engineering', null, '62_M', '2026-09-10', '09:00 AM - 10:30 AM', 'AB4-501', null, null],
    ['CSE332', 'Software Engineering', null, '62_N', '2026-09-10', '09:00 AM - 10:30 AM', 'AB4-502', null, null],
    ['CSE331', 'Database Systems', null, '62_M', '2026-09-12', '11:00 AM - 12:30 PM', 'AB4-601', 213151001, 213151060],
    ['CSE331', 'Database Systems', null, '62_M', '2026-09-12', '11:00 AM - 12:30 PM', 'AB4-602', 213151061, 213151120]
  ];

  const insert = db.prepare(`
    INSERT INTO exam_entries (session_id, course_code, course_title, teacher_initial, section, exam_date, time_slot, room, roll_start, roll_end, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
  `);
  for (const r of rows) await insert.run(sessionId, ...r);

  console.log(`Seeded sample published session "Midterm Exam (Sample)" with ${rows.length} rows.`);
  console.log('Try the student page and search section "62_M" (with/without a roll like 213151030).');
  process.exit(0);
})().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
