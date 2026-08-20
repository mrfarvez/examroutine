/**
 * DIU Exam Seat Plan PDF Parser — v2
 *
 * Specifically designed for manually-created seat plan PDFs with this structure:
 *
 *   Page Header:  "Final Examination, Summer-2026"
 *                  "Date: DD-MM-YYYY  Slot: A (09:00 AM - 11:00 AM)"
 *                  "Total Seat(s): NNNN"
 *   Table Header:  Dept. | ID | Course Title | Tech. Int. | Section | Room No | Seat(s) | Total
 *   Data Rows:     CSE | CSE321 | Computer Networks | FNN | 66_A | G1-001 | 14 | 51
 *                  (merged cells forward-filled: Dept, Course, Title carry down)
 *
 * Pipeline:
 *   1. Extract raw text items with bounding boxes (pdfjs-dist)
 *   2. Group items into rows by Y-proximity
 *   3. Detect page headers (date, slot, table header)
 *   4. Map data rows to columns using header X-positions
 *   5. Forward-fill merged cells, join split room numbers
 */

const Y_TOLERANCE = 8;
const ROW_TOLERANCE = 5;

/* ─── Regex patterns ─── */
const DATE_LABEL_RE = /Date:/i;
const DATE_VALUE_RE = /(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/;
const SLOT_RE = /Slot:\s*([A-Ca-c])\s*\((.+?)\)/;
const TITLE_RE = /Final\s+Examination|Mid[- ]?Term|Exam\s+Routine/i;
const HEADER_DEPT_RE = /Dept\.?/i;
const HEADER_SECTION_RE = /Section/i;
const HEADER_ROOM_RE = /Room/i;

/* ═══════════════════════════════════════════════════
   STAGE 1 — Extract text items with bounding boxes
   ═══════════════════════════════════════════════════ */

async function extractTextItems(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

  const items = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const w = item.width || 0;
      const h = item.height || 0;
      items.push({
        str: item.str.trim(),
        x, y, w, h,
        page: pageNum,
      });
    }
  }
  return { items, totalPages: doc.numPages };
}

/* ═══════════════════════════════════════════════════
   STAGE 2 — Group items into rows by Y-proximity
   ═══════════════════════════════════════════════════ */

function groupIntoRows(items) {
  const byPage = new Map();
  for (const it of items) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }

  const allRows = [];

  for (const [page, pageItems] of byPage) {
    pageItems.sort((a, b) => b.y - a.y || a.x - b.x);

    const rows = [];
    let currentRow = [];
    let lastY = null;

    for (const item of pageItems) {
      if (lastY === null || Math.abs(item.y - lastY) <= ROW_TOLERANCE) {
        currentRow.push(item);
      } else {
        if (currentRow.length) {
          currentRow.sort((a, b) => a.x - b.x);
          rows.push({ page, y: currentRow[0].y, items: currentRow });
        }
        currentRow = [item];
      }
      lastY = item.y;
    }
    if (currentRow.length) {
      currentRow.sort((a, b) => a.x - b.x);
      rows.push({ page, y: currentRow[0].y, items: currentRow });
    }

    allRows.push(...rows);
  }

  return allRows;
}

/* ═══════════════════════════════════════════════════
   STAGE 3 — Detect page headers
   For each page, find: date, slot, and table header row.
   Date is often split across multiple text items, so we
   join the full row text before matching.
   ═══════════════════════════════════════════════════ */

function extractDateFromRow(row) {
  const joined = row.items.map(i => i.str).join(' ');
  // Try: "Date: 19-08-2026" all in one string
  let m = joined.match(DATE_VALUE_RE);
  if (m) return m[1];
  // Try: "Date: 19 - 08 - 2026" split by spaces
  const cleaned = joined.replace(/\s+/g, '');
  m = cleaned.match(/Date:(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/i);
  if (m) return m[1];
  return null;
}

function detectPageHeaders(rows) {
  const pageHeaders = new Map();

  for (const row of rows) {
    const joined = row.items.map(i => i.str).join(' ');
    const page = row.page;

    if (!pageHeaders.has(page)) {
      pageHeaders.set(page, { date: null, slot: null, slotTime: null, headerRow: null, columns: null });
    }
    const header = pageHeaders.get(page);

    // Detect date (handles split items)
    if (!header.date) {
      const dateVal = extractDateFromRow(row);
      if (dateVal) header.date = dateVal;
    }

    // Detect slot
    const slotMatch = joined.match(SLOT_RE);
    if (slotMatch && !header.slot) {
      header.slot = slotMatch[1].toUpperCase();
      header.slotTime = slotMatch[2].trim();
    }

    // Detect table header row (contains Dept and Section/Room)
    if (!header.headerRow) {
      const hasDept = row.items.some(i => HEADER_DEPT_RE.test(i.str));
      const hasSection = row.items.some(i => HEADER_SECTION_RE.test(i.str));
      const hasRoom = row.items.some(i => HEADER_ROOM_RE.test(i.str));

      if (hasDept && (hasSection || hasRoom)) {
        header.headerRow = row;
        header.columns = buildColumnsFromHeader(row.items);
      }
    }
  }

  return pageHeaders;
}

function buildColumnsFromHeader(headerItems) {
  const cols = [];
  for (const item of headerItems) {
    const str = item.str.trim().toLowerCase();
    if (/^dept/i.test(str)) {
      cols.push({ name: 'dept', xCenter: item.x + (item.w || 0) / 2 });
    } else if (/^id$/i.test(str)) {
      cols.push({ name: 'course_code', xCenter: item.x + (item.w || 0) / 2 });
    } else if (/course/i.test(str) || /title/i.test(str)) {
      const existing = cols.find(c => c.name === 'course_title');
      if (existing) {
        existing.xCenter = (existing.xCenter + item.x + (item.w || 0) / 2) / 2;
      } else {
        cols.push({ name: 'course_title', xCenter: item.x + (item.w || 0) / 2 });
      }
    } else if (/tech/i.test(str) || /^int/i.test(str)) {
      const existing = cols.find(c => c.name === 'teacher');
      if (existing) {
        existing.xCenter = (existing.xCenter + item.x + (item.w || 0) / 2) / 2;
      } else {
        cols.push({ name: 'teacher', xCenter: item.x + (item.w || 0) / 2 });
      }
    } else if (/section/i.test(str)) {
      cols.push({ name: 'section', xCenter: item.x + (item.w || 0) / 2 });
    } else if (/room/i.test(str)) {
      const existing = cols.find(c => c.name === 'room');
      if (existing) {
        existing.xCenter = (existing.xCenter + item.x + (item.w || 0) / 2) / 2;
      } else {
        cols.push({ name: 'room', xCenter: item.x + (item.w || 0) / 2 });
      }
    } else if (/seat/i.test(str)) {
      cols.push({ name: 'seats', xCenter: item.x + (item.w || 0) / 2 });
    } else if (/total/i.test(str)) {
      cols.push({ name: 'total', xCenter: item.x + (item.w || 0) / 2 });
    }
  }

  cols.sort((a, b) => a.xCenter - b.xCenter);

  const boundaries = [];
  for (let i = 0; i < cols.length; i++) {
    const xMin = i === 0 ? 0 : (cols[i - 1].xCenter + cols[i].xCenter) / 2;
    const xMax = i === cols.length - 1 ? 700 : (cols[i].xCenter + cols[i + 1].xCenter) / 2;
    boundaries.push({ name: cols[i].name, xMin, xCenter: cols[i].xCenter, xMax });
  }

  return boundaries;
}

/* ═══════════════════════════════════════════════════
   STAGE 4 — Map data rows to columns
   ═══════════════════════════════════════════════════ */

function assignItemToColumn(item, columns) {
  let bestCol = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const dist = Math.abs(item.x + (item.w || 0) / 2 - col.xCenter);
    if (dist < bestDist) {
      bestDist = dist;
      bestCol = col.name;
    }
  }
  if (bestDist > 80) return null;
  return bestCol;
}

function mapRowToColumns(row, columns) {
  const cells = {};
  for (const col of columns) {
    cells[col.name] = [];
  }

  for (const item of row.items) {
    const colName = assignItemToColumn(item, columns);
    if (colName && cells[colName]) {
      cells[colName].push(item.str);
    }
  }

  const result = {};
  for (const [key, values] of Object.entries(cells)) {
    result[key] = values.join(' ').trim();
  }
  return result;
}

function joinRoomNumber(cellStr) {
  if (!cellStr) return null;
  let cleaned = cellStr.replace(/\s+/g, '');
  cleaned = cleaned.replace(/([A-Za-z0-9])\s*-\s*([A-Za-z0-9])/g, '$1-$2');
  return cleaned || null;
}

/* ═══════════════════════════════════════════════════
   STAGE 5 — Parse data rows with forward-fill
   ═══════════════════════════════════════════════════ */

function isHeaderOrMetaRow(row) {
  const joined = row.items.map(i => i.str).join(' ');
  if (HEADER_DEPT_RE.test(joined) && (HEADER_SECTION_RE.test(joined) || HEADER_ROOM_RE.test(joined))) return true;
  if (TITLE_RE.test(joined)) return true;
  if (DATE_LABEL_RE.test(joined)) return true;
  if (/Total\s+Seat/i.test(joined)) return true;
  return false;
}

function parseDataRows(rows, pageHeaders, totalPages) {
  const results = [];
  const unparsedLines = [];

  // Group rows by page
  const rowsByPage = new Map();
  for (const row of rows) {
    if (!rowsByPage.has(row.page)) rowsByPage.set(row.page, []);
    rowsByPage.get(row.page).push(row);
  }

  // Carry-forward state across ALL pages
  let globalColumns = null;
  let globalDate = null;
  let globalSlot = null;
  let globalSlotTime = null;
  let lastDept = null;
  let lastCourseCode = null;
  let lastCourseTitle = null;
  let lastTeacher = null;
  let lastSection = null;

  for (let page = 1; page <= totalPages; page++) {
    const header = pageHeaders.get(page);
    const pageRows = rowsByPage.get(page) || [];

    // Update carry-forward from this page's header
    if (header) {
      if (header.columns) globalColumns = header.columns;
      if (header.date) globalDate = header.date;
      if (header.slot) {
        globalSlot = header.slot;
        globalSlotTime = header.slotTime;
      }
    }

    if (!globalColumns) {
      console.log(`[parser] Page ${page}: no columns available yet, skipping`);
      continue;
    }

    const columns = globalColumns;

    for (const row of pageRows) {
      if (isHeaderOrMetaRow(row)) continue;
      if (row.items.length < 2) continue;

      const cells = mapRowToColumns(row, columns);

      // Forward-fill: dept, course_code, course_title, teacher, section
      if (cells.dept && cells.dept.trim()) lastDept = cells.dept.trim();
      else cells.dept = lastDept || null;

      if (cells.course_code && cells.course_code.trim()) lastCourseCode = cells.course_code.trim();
      else cells.course_code = lastCourseCode || null;

      if (cells.course_title && cells.course_title.trim()) lastCourseTitle = cells.course_title.trim();
      else cells.course_title = lastCourseTitle || null;

      if (cells.teacher && cells.teacher.trim()) lastTeacher = cells.teacher.trim();
      else cells.teacher = lastTeacher || null;

      if (cells.section && cells.section.trim()) lastSection = cells.section.trim().toUpperCase();
      else cells.section = lastSection || null;

      // Must have at least course_code or section
      if (!cells.course_code && !cells.section) {
        unparsedLines.push(row.items.map(i => i.str).join(' '));
        continue;
      }

      // Must have room or seats
      const hasRoom = cells.room && cells.room.trim();
      const hasSeats = cells.seats && cells.seats.trim();
      if (!hasRoom && !hasSeats) {
        unparsedLines.push(row.items.map(i => i.str).join(' '));
        continue;
      }

      results.push({
        course_code: cells.course_code || null,
        course_title: cells.course_title || null,
        teacher_initial: cells.teacher || null,
        section: cells.section || null,
        room: joinRoomNumber(cells.room),
        seats: cells.seats ? parseInt(cells.seats, 10) || null : null,
        total: cells.total ? parseInt(cells.total, 10) || null : null,
        exam_date: globalDate || null,
        time_slot: globalSlot ? `Slot ${globalSlot} (${globalSlotTime})` : (globalSlotTime || null),
        source: 'seatplan',
      });
    }
  }

  return { results, unparsedLines };
}

/* ═══════════════════════════════════════════════════
   Main parse entry point
   ═══════════════════════════════════════════════════ */

async function parsePdfBuffer(buffer, type) {
  const { items, totalPages } = await extractTextItems(buffer);
  console.log(`[parser] Extracted ${items.length} text items from ${totalPages} page(s)`);

  const rows = groupIntoRows(items);
  console.log(`[parser] Grouped into ${rows.length} rows`);

  const pageHeaders = detectPageHeaders(rows);
  for (const [page, header] of pageHeaders) {
    console.log(`[parser] Page ${page}: date="${header.date}" slot="${header.slot}" headerFound=${!!header.headerRow} columns=${header.columns ? header.columns.length : 0}`);
  }

  const { results, unparsedLines } = parseDataRows(rows, pageHeaders, totalPages);
  console.log(`[parser] Result: ${results.length} parsed, ${unparsedLines.length} unparsed`);

  return {
    totalLines: items.length,
    parsedRows: results,
    unparsedLines,
    debug: {
      totalPages,
      pagesWithHeaders: [...pageHeaders.entries()].map(([page, h]) => ({
        page,
        date: h.date,
        slot: h.slot,
        slotTime: h.slotTime,
        headerFound: !!h.headerRow,
        columnCount: h.columns ? h.columns.length : 0,
      })),
    },
  };
}

module.exports = { parsePdfBuffer };
