# DIU Exam Schedule Finder

Admin uploads a **Routine PDF** and/or **Seat Plan PDF** → the app parses
them → students search by **Section** (+ optional Roll) to see which
**room, date and time** they have each exam.

See `ANALYSIS.md` for the full design write-up (data model, parsing
strategy, why there's a manual "Review & Fix" step).

## Run it

```bash
npm install
cp .env.example .env      # then edit ADMIN_USERNAME / ADMIN_PASSWORD / SESSION_SECRET
npm start                 # http://localhost:3000
```

- Student page: `http://localhost:3000/`
- Admin panel: `http://localhost:3000/admin.html`
  (default login is whatever you set in `.env`; if you never edit `.env`,
  it falls back to `admin` / `admin123` — **change this before deploying**)

Optional: see it working instantly with fake data:

```bash
npm run seed
```
Then search section `62_M` on the student page (try roll `213151030` too).

## How to use it for real

1. Log into `/admin.html`.
2. Create a session, e.g. "Midterm Fall 2026".
3. Open it → upload your **Seat Plan PDF** (choose file type "Seat plan").
   Optionally also upload the **Routine PDF** (file type "Routine") if you
   want course/section cross-referencing.
4. The parser extracts what it can into the **Review & Fix** grid below.
   Fix any wrong/missing cells directly in the grid (it autosaves), and use
   **+ Add row** for anything the parser missed entirely.
5. Click **Publish to students** — the section now appears on the public
   search page.

## Project layout

```
server.js            Express app + all API routes
db.js                 SQLite schema + connection
parser/pdfParser.js   Heuristic PDF -> row extraction
public/               Static frontend (student + admin), no build step
seed.js                Optional sample data
```

## Merging into your existing site

Everything here is plain Express + static HTML/CSS/JS with **no framework
lock-in**, specifically so you can:

- mount the API routes (`server.js`) under your existing backend, or
- keep this as a standalone service and just link/iframe `/` and
  `/admin.html` from your existing site, or
- copy the `public/` HTML/CSS/JS into your existing site's templates and
  point the `fetch()` calls at wherever you host the API.

## Tuning the PDF parser to your exact PDF

The parser in `parser/pdfParser.js` uses generic regex patterns for
date/time/room/section/course/roll-range. If your real seat plan PDF has a
consistent layout, share a sample and the regexes can be tightened so far
fewer rows need manual fixing in the Review & Fix screen.
