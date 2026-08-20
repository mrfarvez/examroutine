# DIU Exam Schedule Finder — Analysis & Design Document

Reference inspiration: https://routine.zohirrayhan.me/ (class routine finder).
This project is a **different, exam-focused** tool: admin uploads Routine PDF +
Seat Plan PDF → system parses them → students search by **Section** (and
optional Roll/Student ID) to see **which room, date, and time** they have
each exam.

---

## 1. Problem Restated

- Admin (you) has two PDF sources:
  1. **Routine PDF** — regular class routine (which course belongs to which
     section, teacher, etc.)
  2. **Seat Plan PDF** — exam seating arrangement (date, time slot, room,
     and which section / roll-range sits where)
- Admin uploads both from an **admin panel** (no manual DB typing).
- System must **analyze/parse** the PDFs into structured data.
- A **student** (no login needed) picks their **Section** (and can narrow
  by Roll) and instantly sees: **Course → Date → Time → Room**.

## 2. Key Real-World Constraint (important)

DIU seat-plan PDFs are **not machine-uniform** — different departments/
semesters format tables differently (sometimes section-wise blocks, sometimes
roll-range-per-room tables, sometimes merged cells). A 100%-automatic parser
that never needs correction is unrealistic to promise.

**Design decision:** the parser does **best-effort automatic extraction**,
but every upload lands in a **"Review & Fix" draft screen** in the admin
panel before it goes live to students. This makes the system reliable
regardless of PDF quirks, and is exactly how the reference site's own
"submit for approval" pattern works for CR/teacher data.

## 3. Data Model

```
exam_sessions            (one row per "Midterm Fall-2026", "Final Fall-2026", etc.)
  id, name, term, status(draft|published), created_at

exam_entries              (the parsed, student-facing rows)
  id, session_id -> exam_sessions
  course_code, course_title
  section                 e.g. "62_M"
  date                    e.g. "2026-09-10"
  time_slot               e.g. "09:00 AM - 10:30 AM"
  room
  roll_start, roll_end    (nullable — only when seat plan splits a section by roll)
  source                  'routine' | 'seatplan' | 'manual'

routine_entries           (optional cross-reference: course<->section<->teacher)
  id, course_code, course_title, section, teacher_initial

uploads                   (audit trail of every PDF processed)
  id, session_id, type(routine|seatplan), original_filename,
  stored_path, parsed_row_count, status, uploaded_at

admin_users
  id, username, password_hash
```

## 4. Processing Pipeline

```
Admin uploads PDF
      │
      ▼
Extract raw text + tables  (pdf-parse for text, custom table-row regex)
      │
      ▼
Heuristic column mapper:
  - detect header row (Date / Time / Room / Course / Section / Roll)
  - map each subsequent row into exam_entries (status: draft)
      │
      ▼
Admin "Review & Fix" grid (editable table: add/edit/delete rows,
bulk find-replace on section names, merge duplicate rooms, etc.)
      │
      ▼
Admin clicks "Publish" → session.status = published
      │
      ▼
Student search reads ONLY published sessions
```

## 5. Student-Facing Search Logic

1. Student selects **Section** from dropdown (populated from published data).
2. Optionally enters **Roll number**.
3. System returns all `exam_entries` where:
   - `section == selected`, **and**
   - if the row has a roll range, `roll_start <= roll <= roll_end`
     (falls back to section-wide row if student leaves roll blank or no
     range matches).
4. Results sorted by date, then time. Shown as a clean card/table:
   **Course | Date | Time | Room**, with a "Download / Screenshot" friendly
   layout (mirrors the reference site's "Download PDF" convenience feature).

## 6. Tech Stack (kept simple so you can self-host / merge easily)

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Express | single language, easy to merge into an existing Node/PHP-agnostic stack, easy to containerize |
| DB | SQLite (better-sqlite3) | zero-config, single file, trivial to back up/inspect, upgradeable to MySQL later without changing the API shape |
| PDF parsing | `pdf-parse` (text) + custom table-row heuristics | no external services, works offline |
| Auth (admin) | simple session cookie + bcrypt password | you're the only admin; no need for OAuth complexity |
| Frontend | Plain HTML/CSS/JS (no build step) | drops straight into any existing site, no framework lock-in, easiest to "merge later" as you said |

## 7. Admin Panel — Screens

1. **Login**
2. **Dashboard** — list of exam sessions (draft/published), "New Session"
3. **Upload** — pick session, upload Routine PDF and/or Seat Plan PDF
4. **Review & Fix** — editable spreadsheet-like grid of parsed rows +
   "Publish" button
5. **Manage Published** — unpublish / edit / delete rows post-publish

## 8. Student Panel — Screens

1. **Home** — Section dropdown + optional Roll input + "Find My Exams"
2. **Results** — table of upcoming exams for that section/roll

## 9. What I'm Building Now

A working, runnable full-stack project matching the above (Node/Express +
SQLite + vanilla JS), including the PDF review/fix workflow, seeded with a
sample dataset so you can see it work immediately, and clear instructions
for pointing it at your real PDFs.

**Note on parsing accuracy:** because I don't have a real DIU seat-plan PDF
sample in front of me right now, the auto-parser ships with sensible generic
heuristics + the manual Review & Fix screen as the safety net. If you upload
a real sample later in this chat, I can tune the parser's column-detection
regex specifically to your PDF's exact layout for near-zero manual fixing.
