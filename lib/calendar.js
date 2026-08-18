// ============================================================================
// lib/calendar.js — the variety calendar for the public corn cast page.
//
// Pure functions, no I/O: takes the computed blocks from lib/corncast.js and
// produces everything the timeline needs — one lane per variety, availability
// bars (a block's EARLY→DONE arc) merged when they overlap or nearly touch,
// frost capping, a month axis, and the per-bar popover content. All geometry
// is precomputed as percentages of the axis span so the template stays dumb.
// ============================================================================
const gdd = require('./gdd');
const { fmtDate, maybeTilde, frostPhrase } = require('./corncast');

// Fixed per-variety hues (a design-pass palette). NEVER reassigned or cycled:
// the same variety keeps the same hue everywhere on the page, forever.
// Unknown varieties get the neutral fallback — deterministic, not a cycle.
const VARIETY_COLORS = {
  Kickoff: '#2a78d6',   // blue
  Patriarch: '#eb6834', // orange
  Kate: '#1baf7a',      // aqua
  Bolt: '#eda100',      // yellow
};
const FALLBACK_COLOR = '#64748b'; // neutral slate

// How close two spans of the same variety can sit and still read as one bar:
// overlapping, or separated by at most this many empty days.
const MERGE_GAP_DAYS = 4;

// ---------- small color helpers (hex in, hex out) ----------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return '#' + rgb.map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
}
// Future/forecast portions use a lighter tint of the same hue (~57% to white).
function tintOf(hex) {
  return rgbToHex(hexToRgb(hex).map(c => c + (255 - c) * 0.57));
}
// 1px edge border: the hue darkened ~15%, so pale bars keep definition.
function borderOf(hex) {
  return rgbToHex(hexToRgb(hex).map(c => c * 0.85));
}

function colorsFor(variety) {
  const color = VARIETY_COLORS[variety] || FALLBACK_COLOR;
  return { color, tint: tintOf(color), border: borderOf(color) };
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- popover content for one planting ----------
function plantingDetail(block) {
  return {
    label: block.label,
    status: block.status,
    limitedSupply: block.limitedSupply,
    frostRace: block.state === 'frost-race',
    // Stage windows reuse the block's already-computed (and already
    // frost-capped, ~-conventioned) segment labels.
    windows: block.segments
      ? block.segments.map(s => ({ label: s.label, dates: s.datesLabel }))
      : null,
  };
}

/**
 * buildVarietyCalendar(blocks, today, frostWatch)
 *   blocks     — from buildCornCast(); only public ones are used
 *   today      — "YYYY-MM-DD"
 *   frostWatch — "YYYY-MM-DD" or null
 *
 * Returns null when there is nothing to draw, else:
 * {
 *   axis: {
 *     start, end,                        // ISO dates of the drawn range
 *     months: [{ pct, label }],          // gridline ticks (1st of month)
 *     today: { pct, label } | null,      // null if today is off-axis
 *     frost: { pct, label } | null,      // dashed frost-watch line
 *   },
 *   lanes: [{
 *     variety, slug, color, tint, border,
 *     segments: [{
 *       id,                              // e.g. "kickoff-1", "kickoff-frost"
 *       frostRace,                       // true -> hollow dashed chip
 *       start, end,                      // real projected/observed arc
 *       startApprox, endApprox,
 *       frostCapped,                     // projected end ran past frostWatch
 *       leftPct, widthPct,               // geometry on the axis
 *       pastPct,                         // % of the bar that is past/observed
 *       plantings: [plantingDetail...],  // ONLY this bar's constituents
 *     }],
 *   }],
 * }
 */
function buildVarietyCalendar(blocks, today, frostWatch) {
  const usable = blocks.filter(b => b.isPublic && b.state !== 'unprojectable');

  // --- 1. Group per variety: availability spans + frost-race blocks.
  const byVariety = new Map();
  for (const b of usable) {
    let entry = byVariety.get(b.varietyName);
    if (!entry) {
      entry = { variety: b.varietyName, spans: [], frostRacers: [] };
      byVariety.set(b.varietyName, entry);
    }
    if (b.state === 'frost-race') {
      entry.frostRacers.push(b);
    } else if (b.stages.early && b.stages.done) {
      entry.spans.push({
        start: b.stages.early.date,
        startApprox: b.stages.early.approx,
        end: b.stages.done.date,
        endApprox: b.stages.done.approx,
        blocks: [b],
      });
    }
  }

  // --- 2. Merge spans that overlap or sit within MERGE_GAP_DAYS of each other.
  for (const entry of byVariety.values()) {
    entry.spans.sort((a, b) => (a.start < b.start ? -1 : 1));
    const merged = [];
    for (const span of entry.spans) {
      const last = merged[merged.length - 1];
      // Empty days between: start the day after `last.end` ends.
      if (last && gdd.daysBetween(last.end, span.start) - 1 <= MERGE_GAP_DAYS) {
        if (span.end > last.end) {
          last.end = span.end;
          last.endApprox = span.endApprox;
        }
        last.blocks.push(...span.blocks);
      } else {
        merged.push(span);
      }
    }
    entry.spans = merged;
  }

  const entries = Array.from(byVariety.values())
    .filter(e => e.spans.length > 0 || e.frostRacers.length > 0);
  if (entries.length === 0) return null;

  // --- 3. Frost capping: a PROJECTED end past the cutoff is drawn to the
  //        frost line and flagged; an actual end is history and never capped.
  for (const entry of entries) {
    for (const span of entry.spans) {
      span.frostCapped = !!(frostWatch && span.endApprox && span.end > frostWatch);
      span.drawEnd = span.frostCapped ? frostWatch : span.end;
    }
  }

  // --- 4. The axis: ~1 week before the earliest start, to frostWatch + 1 week
  //        (stretched if something actual runs later than that).
  const starts = entries.flatMap(e => e.spans.map(s => s.start));
  const ends = entries.flatMap(e => e.spans.map(s => s.drawEnd));
  const earliest = starts.length > 0 ? starts.sort()[0] : today;
  const latestDrawn = ends.length > 0 ? ends.sort()[ends.length - 1] : today;
  const axisStart = gdd.addDays(earliest, -7);
  let axisEnd = frostWatch ? gdd.addDays(frostWatch, 7) : gdd.addDays(latestDrawn, 7);
  if (latestDrawn > axisEnd) axisEnd = gdd.addDays(latestDrawn, 3);
  const spanDays = Math.max(1, gdd.daysBetween(axisStart, axisEnd));
  const pct = date => (gdd.daysBetween(axisStart, date) / spanDays) * 100;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months = [];
  let m = axisStart.slice(0, 7); // walk month by month from the axis start
  for (let i = 0; i < 14; i++) {
    const first = m + '-01';
    if (first > axisEnd) break;
    if (first >= axisStart) {
      months.push({ pct: pct(first), label: MONTHS[Number(m.slice(5, 7)) - 1] });
    }
    const next = new Date(m + '-01T00:00:00Z');
    next.setUTCMonth(next.getUTCMonth() + 1);
    m = next.toISOString().slice(0, 7);
  }
  // The axis usually starts mid-month, which would leave the leading region
  // (where the first bars sit) unlabeled. Label the left edge with the
  // starting month — a "partial" tick with no gridline — unless the first
  // real tick sits too close for the two labels to coexist.
  if (axisStart.slice(8, 10) !== '01' && (months.length === 0 || months[0].pct >= 6)) {
    months.unshift({ pct: 0, label: MONTHS[Number(axisStart.slice(5, 7)) - 1], partial: true });
  }

  const axis = {
    start: axisStart,
    end: axisEnd,
    months,
    today: (today >= axisStart && today <= axisEnd)
      ? { pct: pct(today), label: 'today' }
      : null,
    frost: frostWatch
      ? { pct: pct(frostWatch), label: `frost watch ~${fmtDate(frostWatch)}` }
      : null,
  };

  // --- 5. Lanes, ordered by each variety's earliest presence.
  const lanes = entries
    .map(entry => {
      const slug = slugify(entry.variety);
      const segments = entry.spans.map((span, i) => {
        const left = pct(span.start);
        const width = Math.max(1.5, pct(span.drawEnd) - left);
        // Solid (past/observed) share of the drawn bar; the rest is tint.
        const drawnDays = Math.max(1, gdd.daysBetween(span.start, span.drawEnd));
        const pastPct = today <= span.start ? 0
          : today >= span.drawEnd ? 100
          : (gdd.daysBetween(span.start, today) / drawnDays) * 100;
        return {
          id: `${slug}-${i + 1}`,
          frostRace: false,
          start: span.start,
          end: span.end,
          startApprox: span.startApprox,
          endApprox: span.endApprox,
          frostCapped: span.frostCapped,
          startLabel: maybeTilde(span.start, span.startApprox),
          endLabel: span.frostCapped
            ? `~${frostPhrase(frostWatch)}, weather permitting`
            : maybeTilde(span.end, span.endApprox),
          leftPct: left,
          widthPct: width,
          pastPct,
          plantings: span.blocks.map(plantingDetail),
        };
      });
      // All of a variety's frost-race blocks share ONE dashed chip that ends
      // at the frost line (or the axis end when no frost date is set).
      if (entry.frostRacers.length > 0) {
        const chipWidth = 6;
        const lineAt = axis.frost ? axis.frost.pct : 100;
        segments.push({
          id: `${slug}-frost`,
          frostRace: true,
          start: null,
          end: null,
          startApprox: true,
          endApprox: true,
          frostCapped: false,
          startLabel: null,
          endLabel: null,
          leftPct: Math.max(0, lineAt - chipWidth),
          widthPct: chipWidth,
          pastPct: 0,
          plantings: entry.frostRacers.map(plantingDetail),
        });
      }
      const firstAt = segments.reduce((min, s) => Math.min(min, s.leftPct), 100);
      return { variety: entry.variety, slug, ...colorsFor(entry.variety), segments, firstAt };
    })
    .sort((a, b) => a.firstAt - b.firstAt);

  return { axis, lanes };
}

module.exports = { buildVarietyCalendar, VARIETY_COLORS };
