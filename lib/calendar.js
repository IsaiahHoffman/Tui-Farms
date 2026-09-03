// ============================================================================
// lib/calendar.js — the variety calendar for the public corn cast page.
//
// Pure functions, no I/O: takes the computed blocks from lib/corncast.js and
// produces everything the timeline needs — one lane per variety, availability
// bars (a block's EARLY→DONE arc) merged when they overlap or nearly touch,
// frost capping, the frost-risk bar, a month axis, and the per-bar popover
// content. All geometry is precomputed as percentages of the axis span so the
// template stays dumb.
// ============================================================================
const gdd = require('./gdd');
const { fmtDate, maybeTilde, frostPhrase } = require('./corncast');
const { buildFrostRisk, chanceLabel } = require('./frost');

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

// A frost racer's whole pick window sits past the frost line, so its bar is a
// short forecast stub from the projected first pick, drawn this many days
// long and fading out. The length is nominal — the fade says "no promised
// end" — it just has to be visible.
const RACE_BAR_DAYS = 10;

// Frost-risk bar: pale ice at 0% climbing to deep steel at 100%.
const RISK_LIGHT = '#e4ecf4';
const RISK_DARK = '#2b4b6b';

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
// Straight blend from a to b (t = 0..1).
function mixHex(a, b, t) {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  return rgbToHex(from.map((c, i) => c + (to[i] - c) * t));
}

function colorsFor(variety) {
  const color = VARIETY_COLORS[variety] || FALLBACK_COLOR;
  return { color, tint: tintOf(color), border: borderOf(color) };
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- popover content for one segment's plantings ----------
// PUBLIC view: block identity (labels, field names, planting dates) is
// farmer-speak and never leaves the server. Customers see anonymous,
// numbered plantings — and finished ones collapse into one summary line.
function segmentPlantings(blocks, today) {
  // Active/future plantings, numbered by ready order within this segment.
  const plantings = blocks
    .filter(b => b.status !== 'done')
    .sort((a, b) => {
      const aDate = a.stages.early ? a.stages.early.date : '9999';
      const bDate = b.stages.early ? b.stages.early.date : '9999';
      return aDate < bDate ? -1 : 1;
    })
    .map((b, i) => ({
      name: `Planting ${i + 1}`,
      status: b.status,
      limitedSupply: b.limitedSupply,
      frostRace: b.state === 'frost-race',
      // Stage windows reuse the block's already-computed (and already
      // frost-capped, ~-conventioned) segment labels.
      windows: b.segments
        ? b.segments.map(s => ({ label: s.label, dates: s.datesLabel }))
        : null,
    }));

  // Done plantings: one line, first eating-fresh start to last done.
  const done = blocks.filter(b => b.status === 'done' && b.stages.early && b.stages.done);
  let doneSummary = null;
  if (done.length > 0) {
    let first = done[0].stages.early;
    let last = done[0].stages.done;
    for (const b of done) {
      if (b.stages.early.date < first.date) first = b.stages.early;
      if (b.stages.done.date > last.date) last = b.stages.done;
    }
    // A finished planting cannot have been picked in the future: a done block
    // without a done observation still projects its done stage forward, so
    // cap the summary at today.
    if (last.date > today) last = { date: today, approx: true };
    doneSummary = `${done.length === 1 ? 'An earlier planting' : 'Earlier plantings'} picked `
      + `${maybeTilde(first.date, first.approx)} – ${maybeTilde(last.date, last.approx)}`;
  }

  return { plantings, doneSummary };
}

// Merge spans that overlap or sit within MERGE_GAP_DAYS of each other.
function mergeSpans(spans) {
  spans.sort((a, b) => (a.start < b.start ? -1 : 1));
  const merged = [];
  for (const span of spans) {
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
  return merged;
}

/**
 * buildVarietyCalendar(blocks, today, frostWatch, frostRiskOverride)
 *   blocks            — from buildCornCast(); only public ones are used
 *   today             — "YYYY-MM-DD"
 *   frostWatch        — "YYYY-MM-DD" or null
 *   frostRiskOverride — optional { p10, p90 } from cornConfig (see lib/frost.js)
 *
 * Returns null when there is nothing to draw, else:
 * {
 *   axis: {
 *     start, end,                        // ISO dates of the drawn range
 *     months: [{ pct, label }],          // gridline ticks (1st of month)
 *     today: { pct, label } | null,      // null if today is off-axis
 *     frost: { pct, label } | null,      // dashed frost-watch line
 *   },
 *   frostRisk: {                         // the bar in the top lane, or null
 *     leftPct, widthPct,                 // geometry on the axis
 *     gradient,                          // CSS linear-gradient, 0% -> 100%
 *     ticks: [{ pct, label, dark, end }],// "10%" ... placed within the bar
 *     lines: [string],                   // popover copy
 *   } | null,
 *   lanes: [{
 *     variety, slug, color, tint, border,
 *     segments: [{
 *       id,                              // e.g. "kickoff-1", "kickoff-race-1"
 *       frostRace,                       // true -> forecast stub past the frost line
 *       start, end,                      // real projected/observed arc (end null for a racer)
 *       startApprox, endApprox,
 *       frostCapped,                     // drawn end is not a promise: fade it out
 *       leftPct, widthPct,               // geometry on the axis
 *       pastPct,                         // % of the bar that is past/observed
 *       raceNote,                        // racer popover sentence, else null
 *       // ONLY this bar's constituents, anonymized for the public view:
 *       plantings: [{name: "Planting 1", status, limitedSupply, frostRace,
 *                    windows: [{label, dates}] | null}],  // active/future only
 *       doneSummary,                     // one line for finished plantings|null
 *     }],
 *   }],
 * }
 */
function buildVarietyCalendar(blocks, today, frostWatch, frostRiskOverride) {
  const usable = blocks.filter(b => b.isPublic && b.state !== 'unprojectable');
  const risk = buildFrostRisk(frostWatch, frostRiskOverride); // null without a frost date

  // --- 1. Group per variety: availability spans, plus frost racers that have
  //        a projected first pick. (A racer with no date at all has nothing
  //        to draw — the season line still speaks for it.)
  const byVariety = new Map();
  for (const b of usable) {
    let entry = byVariety.get(b.varietyName);
    if (!entry) {
      entry = { variety: b.varietyName, spans: [], raceSpans: [] };
      byVariety.set(b.varietyName, entry);
    }
    if (b.state === 'frost-race') {
      if (b.stages.early) {
        entry.raceSpans.push({
          start: b.stages.early.date,
          startApprox: b.stages.early.approx,
          end: gdd.addDays(b.stages.early.date, RACE_BAR_DAYS), // nominal, see RACE_BAR_DAYS
          endApprox: true,
          race: true,
          blocks: [b],
        });
      }
    } else if (b.stages.early && b.stages.done) {
      entry.spans.push({
        start: b.stages.early.date,
        startApprox: b.stages.early.approx,
        end: b.stages.done.date,
        endApprox: b.stages.done.approx,
        race: false,
        blocks: [b],
      });
    }
  }

  // --- 2. Merge spans that overlap or sit within MERGE_GAP_DAYS of each other.
  for (const entry of byVariety.values()) {
    entry.spans = mergeSpans(entry.spans);
    entry.raceSpans = mergeSpans(entry.raceSpans);
  }

  const entries = Array.from(byVariety.values())
    .filter(e => e.spans.length > 0 || e.raceSpans.length > 0);
  if (entries.length === 0) return null;

  // --- 3. Frost capping: a PROJECTED end past the cutoff is drawn to the
  //        frost line and flagged; an actual end is history and never capped.
  //        A racer's stub is always "capped": its end is never a promise.
  for (const entry of entries) {
    for (const span of entry.spans) {
      span.frostCapped = !!(frostWatch && span.endApprox && span.end > frostWatch);
      span.drawEnd = span.frostCapped ? frostWatch : span.end;
    }
    for (const span of entry.raceSpans) {
      span.frostCapped = true;
      span.drawEnd = span.end;
    }
  }

  // --- 4. The axis: ~1 week before the earliest start, to frostWatch + 1 week
  //        (stretched if something — an actual late end, or a racer's stub —
  //        runs later than that).
  const allSpans = entries.flatMap(e => e.spans.concat(e.raceSpans));
  const starts = allSpans.map(s => s.start);
  const ends = allSpans.map(s => s.drawEnd);
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

  // --- 5. The frost-risk bar: from where the odds leave 0% to the axis end,
  //        colored by the chance itself, with the 10 / 50 / 90% marks on it.
  let frostRisk = null;
  if (risk && risk.p0 < axisEnd) {
    const barStart = risk.p0 > axisStart ? risk.p0 : axisStart;
    const left = pct(barStart);
    const width = Math.max(1, 100 - left);
    const inBar = date => ((pct(date) - left) / width) * 100; // 0..100 within the bar
    const colorAt = date => mixHex(RISK_LIGHT, RISK_DARK, risk.chanceOn(date) / 100);
    const stopDates = [barStart, risk.p10, risk.p50, risk.p90, risk.p100, axisEnd]
      .filter(d => d >= barStart && d <= axisEnd)
      .sort();
    const stops = stopDates.map(d => `${colorAt(d)} ${inBar(d).toFixed(1)}%`);

    // The anchors that fit on the bar get a label; if the axis ends before
    // the 90% mark, the reading at the axis end closes the bar out instead.
    const ticks = [];
    for (const [date, chance] of [[risk.p10, 10], [risk.p50, 50], [risk.p90, 90]]) {
      if (date >= barStart && gdd.daysBetween(date, axisEnd) >= 3) {
        ticks.push({ pct: inBar(date), label: `${chance}%`, dark: chance < 45, end: false });
      }
    }
    if (!ticks.some(t => t.label === '90%')) {
      const c = risk.chanceOn(axisEnd);
      ticks.push({ pct: 100, label: chanceLabel(c), dark: c < 45, end: true });
    }

    frostRisk = {
      leftPct: left,
      widthPct: width,
      gradient: `linear-gradient(to right, ${stops.join(', ')})`,
      ticks,
      lines: [
        `About 10% by ${fmtDate(risk.p10)}, a coin flip by ${fmtDate(risk.p50)}, `
          + `and 90% by ${fmtDate(risk.p90)} — going by typical falls here in Manheim.`,
        `Right now: ${chanceLabel(risk.chanceOn(today))}.`,
      ],
    };
  }

  // --- 6. Lanes, ordered by each variety's earliest presence.
  const lanes = entries
    .map(entry => {
      const slug = slugify(entry.variety);
      const segmentOf = (span, id) => {
        const left = pct(span.start);
        const width = Math.max(1.5, pct(span.drawEnd) - left);
        // Solid (past/observed) share of the drawn bar; the rest is tint.
        const drawnDays = Math.max(1, gdd.daysBetween(span.start, span.drawEnd));
        const pastPct = today <= span.start ? 0
          : today >= span.drawEnd ? 100
          : (gdd.daysBetween(span.start, today) / drawnDays) * 100;
        const startLabel = maybeTilde(span.start, span.startApprox);
        let endLabel = null;
        let raceNote = null;
        if (span.race) {
          const odds = risk ? chanceLabel(risk.chanceOn(span.start)) : null;
          raceNote = `If it beats the frost, first picking ${startLabel}`
            + (odds ? ` — but the chance a frost has hit by then is ${odds}.` : '.');
        } else {
          endLabel = span.frostCapped
            ? `~${frostPhrase(frostWatch)}, weather permitting`
            : maybeTilde(span.end, span.endApprox);
        }
        return {
          id,
          frostRace: span.race,
          start: span.start,
          end: span.race ? null : span.end,
          startApprox: span.startApprox,
          endApprox: span.endApprox,
          frostCapped: span.frostCapped,
          startLabel,
          endLabel,
          leftPct: left,
          widthPct: width,
          pastPct,
          raceNote,
          ...segmentPlantings(span.blocks, today),
        };
      };
      const segments = entry.spans.map((span, i) => segmentOf(span, `${slug}-${i + 1}`))
        .concat(entry.raceSpans.map((span, i) => segmentOf(span, `${slug}-race-${i + 1}`)));
      const firstAt = segments.reduce((min, s) => Math.min(min, s.leftPct), 100);
      return { variety: entry.variety, slug, ...colorsFor(entry.variety), segments, firstAt };
    })
    .sort((a, b) => a.firstAt - b.firstAt);

  return { axis, frostRisk, lanes };
}

module.exports = { buildVarietyCalendar, VARIETY_COLORS };
