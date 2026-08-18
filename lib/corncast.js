// ============================================================================
// lib/corncast.js — assembles the corn cast.
//
// Takes varieties + plantings + weather (no file or network access here) and
// produces everything the pages show: per-block stage windows, the one-line
// season summary, the variety history calendar, and the admin drift table.
// The underlying math lives in lib/gdd.js.
// ============================================================================
const gdd = require('./gdd');

const STAGES = ['early', 'prime', 'mature', 'done'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-08-17" -> "Aug 17"
function fmtDate(dateStr) {
  if (!dateStr) return '';
  const month = MONTHS[Number(dateStr.slice(5, 7)) - 1] || '';
  return `${month} ${Number(dateStr.slice(8, 10))}`;
}

// "~Aug 17" when the date rests on forecast / seasonal-estimate data.
function maybeTilde(dateStr, approx) {
  return (approx ? '~' : '') + fmtDate(dateStr);
}

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-10-15" -> "mid-October": how the frost cutoff reads in a sentence.
function frostPhrase(dateStr) {
  const month = MONTHS_FULL[Number(dateStr.slice(5, 7)) - 1] || '';
  const day = Number(dateStr.slice(8, 10));
  const part = day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late';
  return `${part}-${month}`;
}

function crossingInfo(crossing) {
  if (!crossing) return null;
  return {
    date: crossing.date,
    label: fmtDate(crossing.date),
    approx: crossing.source !== 'actual',
    source: crossing.source,
    observed: !!crossing.observed,
  };
}

// ---------- one block ----------
// frostWatch (optional "YYYY-MM-DD"): corn doesn't survive a hard frost, and
// around here mid-October is the historical coin flip. A block whose FIRST
// pickable date lands after frostWatch — or never resolves at all inside the
// projection horizon — is a "frost race": shown honestly, promised nothing.
function buildBlock(planting, varietyByName, weatherByDate, today, frostWatch) {
  const block = {
    id: planting.id,
    label: planting.label,
    varietyName: planting.variety,
    plantedDate: planting.plantedDate,
    acres: planting.acres,           // PRIVATE — only the admin view may show this
    isPublic: planting.public,
    status: planting.status,
    anchors: planting.anchors || [],
    state: 'unprojectable',
    stages: {},                      // { early|prime|mature|done: crossingInfo }
    segments: null,                  // the three bar segments, or null
    todayPct: null,
    limitedSupply: false,
    gddToToday: 0,
    offset: 0,
  };

  const variety = varietyByName.get(planting.variety);
  if (!variety) return block; // stays 'unprojectable'; admin flags it

  const thresholds = gdd.deriveThresholds(variety);
  const projection = gdd.projectCrossings(
    planting.plantedDate, weatherByDate, thresholds, today, planting.anchors
  );

  for (const s of STAGES) block.stages[s] = crossingInfo(projection.crossings[s]);
  block.gddToToday = Math.round(projection.gddToToday);
  block.offset = Math.round(projection.offset);

  const { early, done } = block.stages;
  if (planting.status === 'done') {
    block.state = 'done';
  } else if (!early || (frostWatch && early.date > frostWatch)) {
    // Its first pick never resolves inside the projection horizon, or lands
    // past the frost cutoff — either way it's racing the frost, not scheduled.
    block.state = 'frost-race';
  } else if (today < early.date) {
    block.state = 'future';
  } else if (done && today > done.date) {
    block.state = 'winding-down';
  } else {
    block.state = 'active';
  }

  block.limitedSupply =
    block.state === 'active' && Number.isFinite(planting.acres) && planting.acres < 1.0;

  // The three customer-facing segments of the stage bar.
  // A frost-race block gets NO bar — concrete-looking dates would be a lie.
  const { prime, mature } = block.stages;
  if (early && prime && mature && done && block.state !== 'frost-race') {
    const span = Math.max(1, gdd.daysBetween(early.date, done.date));
    const seg = (key, label, from, to) => {
      // Date ranges reaching past the frost cutoff are capped: the bar keeps
      // its shape, but the text turns into "…weather permitting".
      const allPastFrost = frostWatch && from.date > frostWatch;
      const endPastFrost = frostWatch && to.date > frostWatch;
      const datesLabel = allPastFrost
        ? '…weather permitting'
        : endPastFrost
          ? `${maybeTilde(from.date, from.approx)} – …weather permitting`
          : `${maybeTilde(from.date, from.approx)} – ${maybeTilde(to.date, to.approx)}`;
      return {
        key,
        label,
        datesLabel,
        approx: from.approx || to.approx || !!endPastFrost,
        pct: Math.max(3, (gdd.daysBetween(from.date, to.date) / span) * 100),
      };
    };
    block.segments = [
      seg('fresh', 'Eating-fresh', early, prime),
      seg('prime', 'Prime', prime, mature),
      seg('freezer', 'Freezer-best', mature, done),
    ];
    block.todayPct = Math.min(100, Math.max(0,
      (gdd.daysBetween(early.date, today) / span) * 100
    ));
  }

  return block;
}

// ---------- the one-line season summary ----------
// Built from public, not-done blocks: merge their pick windows [early..done],
// then describe today / the next window / honest gaps / season end.
// Frost-race blocks are excluded from the promised windows; past frostWatch
// the season end is phrased "~mid-October, weather permitting" instead of a
// concrete date the frost would make a lie.
function buildSeasonLine(blocks, today, frostWatch) {
  const windows = blocks
    .filter(b => b.isPublic && b.status !== 'done' && b.state !== 'frost-race'
      && b.stages.early && b.stages.done
      && b.stages.done.date >= today)
    .map(b => ({
      start: b.stages.early.date,
      end: b.stages.done.date,
      startApprox: b.stages.early.approx,
      endApprox: b.stages.done.approx,
    }))
    .sort((a, b) => (a.start < b.start ? -1 : 1));

  // Merge overlapping / adjacent windows.
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= gdd.addDays(last.end, 1)) {
      if (w.end > last.end) {
        last.end = w.end;
        last.endApprox = w.endApprox;
      }
    } else {
      merged.push({ ...w });
    }
  }

  const anyPublic = blocks.some(b => b.isPublic);
  const windingDown = blocks.some(b => b.isPublic && b.state === 'winding-down');
  const frostRace = blocks.some(b => b.isPublic && b.state === 'frost-race');

  if (merged.length === 0) {
    if (windingDown) return 'A little corn may still be left — text ahead to check.';
    if (frostRace) return "Our last corn is racing the fall frost — we'll know closer to October if it makes it.";
    if (anyPublic) return "Sweet corn is done for the season — see you next summer!";
    return null; // nothing to say; pages fall back to the statusNote
  }

  const current = merged.find(w => w.start <= today && today <= w.end);
  const next = merged.find(w => w.start > today);
  const season = merged[merged.length - 1];
  const seasonEnd = (frostWatch && season.end > frostWatch)
    ? `~${frostPhrase(frostWatch)}, weather permitting`
    : maybeTilde(season.end, season.endApprox);

  if (current && next) {
    const breakStart = gdd.addDays(current.end, 1);
    const breakEnd = gdd.addDays(next.start, -1);
    return `Fresh corn is pickable today. Short break ${maybeTilde(breakStart, current.endApprox)}`
      + `–${maybeTilde(breakEnd, next.startApprox)}, then more corn through ${seasonEnd}.`;
  }
  if (current) {
    return `Fresh corn is pickable today — expect corn through ${seasonEnd}.`;
  }
  const line = `Next fresh corn expected around ${maybeTilde(next.start, next.startApprox)}`
    + (next.end !== season.end || merged.length > 1
      ? `; season runs through ${seasonEnd}.`
      : `, through ${seasonEnd}.`);
  return windingDown
    ? `A little corn may still be left — text ahead. ${line}`
    : line;
}

// ---------- variety history calendar ----------
// All public blocks (including done ones) grouped by variety:
// "Variety A — first pick ~Jul 12 to ~Aug 15"
function buildCalendar(blocks) {
  const byVariety = new Map();
  for (const b of blocks) {
    // Frost-race blocks have no real pick history to report.
    if (!b.isPublic || b.state === 'frost-race' || !b.stages.early || !b.stages.done) continue;
    const entry = byVariety.get(b.varietyName) || { variety: b.varietyName, first: null, last: null };
    if (!entry.first || b.stages.early.date < entry.first.date) entry.first = b.stages.early;
    if (!entry.last || b.stages.done.date > entry.last.date) entry.last = b.stages.done;
    byVariety.set(b.varietyName, entry);
  }
  return Array.from(byVariety.values())
    .sort((a, b) => (a.first.date < b.first.date ? -1 : 1))
    .map(e => ({
      variety: e.variety,
      range: `first pick ${maybeTilde(e.first.date, e.first.approx)} to ${maybeTilde(e.last.date, e.last.approx)}`,
    }));
}

// ---------- drift table (admin) ----------
// For every logged observation: what did the UN-anchored model predict for
// that stage, and how far off was it? Because every stage is a rigid offset
// from prime, the GDD delta at ANY observed stage is exactly the shift the
// observation implies for the variety's PRIME number. A consistent pattern of
// positive deltas says "raise primeGDD", negative says "lower it" — and the
// impliedPrimeGDD column is the number that one observation would set.
function buildDriftRows(varieties, plantings, weatherByDate, today) {
  const varietyByName = new Map(varieties.map(v => [v.name, v]));
  const rows = [];
  for (const p of plantings) {
    const variety = varietyByName.get(p.variety);
    if (!variety) continue;
    const thresholds = gdd.deriveThresholds(variety);
    const anchors = (p.anchors || []).filter(a => a && STAGES.includes(a.stage) && gdd.isValidDateStr(a.date));
    if (anchors.length === 0) continue;
    // Predictions WITHOUT any anchor corrections:
    const unanchored = gdd.projectCrossings(p.plantedDate, weatherByDate, thresholds, today, []);
    for (const a of anchors) {
      const predicted = unanchored.crossings[a.stage];
      const gddAtObservation = gdd.accumulateGDD(p.plantedDate, weatherByDate, a.date, today);
      const gddDelta = Math.round(gddAtObservation - thresholds[a.stage]);
      rows.push({
        variety: p.variety,
        block: p.label,
        stage: a.stage,
        observedDate: a.date,
        observedLabel: fmtDate(a.date),
        predictedLabel: predicted ? fmtDate(predicted.date) : '—',
        deltaDays: predicted ? gdd.daysBetween(predicted.date, a.date) : null,
        gddDelta,
        impliedPrimeGDD: Math.round(variety.primeGDD + gddDelta),
      });
    }
  }
  rows.sort((a, b) => (a.variety === b.variety
    ? (a.observedDate < b.observedDate ? -1 : 1)
    : (a.variety < b.variety ? -1 : 1)));
  return rows;
}

/**
 * buildCornCast(varieties, plantings, weatherByDate, today, frostWatch)
 * The one call index.js makes. frostWatch (optional "YYYY-MM-DD") is the frost
 * cutoff: nothing is promised beyond it. Returns:
 *   blocks     — every planting (public and private) with computed stages
 *   seasonLine — one plain-English sentence, or null if there's nothing to say
 *   calendar   — variety history for the public page
 */
function buildCornCast(varieties, plantings, weatherByDate, today, frostWatch) {
  const varietyByName = new Map(varieties.map(v => [v.name, v]));
  const blocks = plantings.map(p => buildBlock(p, varietyByName, weatherByDate, today, frostWatch));
  return {
    blocks,
    seasonLine: buildSeasonLine(blocks, today, frostWatch),
    calendar: buildCalendar(blocks),
  };
}

module.exports = { buildCornCast, buildDriftRows, frostPhrase, fmtDate, maybeTilde, STAGES };
