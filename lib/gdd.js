// ============================================================================
// lib/gdd.js — the corn "formula".
//
// Pure math only: no files, no network. index.js feeds this module weather
// data and planting info; this module answers "when does each block hit each
// quality stage?". This is the one file to tweak as the farm learns how its
// varieties really behave year over year.
//
// Vocabulary:
//   GDD  = growing degree days, a heat-accumulation unit. Corn development
//          tracks accumulated heat much better than calendar days.
//   Threshold = total GDD (from planting) at which a variety reaches a stage
//          (early / prime / mature / done).
//   Anchor = a real-world observation ("this block hit prime on Aug 17") used
//          to correct the model for that particular block.
// ============================================================================

// ---------- small date helpers (ISO "YYYY-MM-DD" strings, UTC math) ----------
// All date arithmetic is done in UTC on plain date strings so the server's
// timezone can never shift a date by a day.

function toUTC(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = toUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

function daysBetween(fromStr, toStr) {
  return Math.round((toUTC(toStr) - toUTC(fromStr)) / 86400000);
}

function isValidDateStr(dateStr) {
  return typeof dateStr === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    && !Number.isNaN(toUTC(dateStr).getTime());
}

// ---------- daily GDD ----------
// "Modified" GDD, base 50°F, ceiling 86°F — the standard formula for corn:
//   * daily high above 86 counts as 86 (corn doesn't develop faster above it)
//   * daily low below 50 counts as 50 (no development below it)
//   * GDD for the day = average of the two, minus the 50° base, floored at 0.
function dailyGDD(tmaxF, tminF) {
  const hi = Math.min(tmaxF, 86);
  const lo = Math.max(tminF, 50);
  return Math.max(0, (hi + lo) / 2 - 50);
}

// ---------- seasonal fallback ----------
// When we run out of real forecast days, assume a "typical year" GDD per day
// for this area, tapering into fall. Linear interpolation between anchors;
// flat before the first anchor and after the last one.
// (Before Aug 15 the 22/day clamp is a fine mid-summer typical value.)
const SEASONAL_GDD_PER_DAY = [
  ['08-15', 22],
  ['09-01', 19],
  ['09-15', 15],
  ['10-01', 10.5],
  ['10-15', 5.5],
  ['11-01', 3],
];

function seasonalGDDForDate(dateStr) {
  const year = dateStr.slice(0, 4);
  const points = SEASONAL_GDD_PER_DAY.map(([monthDay, value]) => [
    toUTC(`${year}-${monthDay}`).getTime(),
    value,
  ]);
  const t = toUTC(dateStr).getTime();
  if (t <= points[0][0]) return points[0][1];
  if (t >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, v0] = points[i];
    const [t1, v1] = points[i + 1];
    if (t >= t0 && t <= t1) {
      return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
    }
  }
  return points[points.length - 1][1]; // unreachable, but be safe
}

// ---------- one day of accumulation ----------
// Returns { gdd, kind } for a single date:
//   kind 'actual'   — real measured weather on or before `todayDate`
//   kind 'forecast' — weather data for a date after `todayDate`
//   kind 'seasonal-estimate' — no weather data at all; typical-year fallback
function gddForDate(dateStr, weatherByDate, todayDate) {
  const day = weatherByDate ? weatherByDate[dateStr] : undefined;
  if (day && Number.isFinite(day.max) && Number.isFinite(day.min)) {
    const kind = dateStr <= todayDate ? 'actual' : 'forecast';
    return { gdd: dailyGDD(day.max, day.min), kind };
  }
  return { gdd: seasonalGDDForDate(dateStr), kind: 'seasonal-estimate' };
}

// ---------- cumulative GDD ----------
// Total GDD from planting THROUGH `uptoDate` (inclusive).
// Accumulation starts the day AFTER planting — planting day itself counts 0.
function accumulateGDD(plantedDate, weatherByDate, uptoDate, todayDate) {
  const today = todayDate || uptoDate;
  let total = 0;
  for (let d = addDays(plantedDate, 1); d <= uptoDate; d = addDays(d, 1)) {
    total += gddForDate(d, weatherByDate, today).gdd;
  }
  return total;
}

// ---------- the projection ----------
// Corn never survives past the first hard frosts, and the seasonal table only
// describes late summer through fall. So the projection walks no further than
// Dec 1 of the planting year — any threshold not reached by then reports null
// ("won't realistically be reached") instead of a nonsense date.
const SEASON_END_MONTH_DAY = '12-01';

/**
 * projectCrossings(plantedDate, weatherByDate, thresholds, todayDate, anchors)
 *
 *   plantedDate   "YYYY-MM-DD"
 *   weatherByDate { "YYYY-MM-DD": { max, min } }  (merged actual + forecast)
 *   thresholds    { stageName: gdd } e.g. { early:1700, prime:1800, ... }
 *   todayDate     "YYYY-MM-DD" — dates <= today are 'actual' data
 *   anchors       optional [{ date:"YYYY-MM-DD", stage:"prime" }, ...]
 *
 * Walks day by day from the day after planting, accumulating GDD (actual
 * weather, then forecast, then the seasonal fallback), and records the first
 * date each threshold is crossed.
 *
 * Anchors: an observation that the block actually hit a stage on a given day.
 * The LATEST anchor wins and defines a per-block offset:
 *     offset = (accumulated GDD on the anchor date) - (that stage's threshold)
 * A positive offset means this block needs MORE heat than the book value, so
 * every remaining threshold shifts later by that same offset. Any stage that
 * was directly observed reports its observed date (source 'actual',
 * observed:true) instead of a modeled one.
 *
 * Returns {
 *   crossings: { stage: { date, source, observed? } | null },
 *   offset,             // GDD offset applied from the winning anchor (0 = none)
 *   anchorUsed,         // the winning anchor, or null
 *   gddToToday,         // accumulated GDD through today (min: 0)
 * }
 */
function projectCrossings(plantedDate, weatherByDate, thresholds, todayDate, anchors = []) {
  const stages = Object.keys(thresholds).filter(s => Number.isFinite(thresholds[s]));

  // --- 1. Pick the winning anchor (latest valid one) and compute the offset.
  const validAnchors = (anchors || []).filter(a =>
    a && isValidDateStr(a.date) && stages.includes(a.stage) && a.date > plantedDate
  );
  validAnchors.sort((a, b) => (a.date < b.date ? -1 : 1));
  const anchorUsed = validAnchors.length > 0 ? validAnchors[validAnchors.length - 1] : null;

  let offset = 0;
  if (anchorUsed) {
    const gddAtAnchor = accumulateGDD(plantedDate, weatherByDate, anchorUsed.date, todayDate);
    offset = gddAtAnchor - thresholds[anchorUsed.stage];
  }

  // --- 2. Directly observed stages report their observed date.
  //        (Latest observation per stage wins.)
  const observedByStage = {};
  for (const a of validAnchors) observedByStage[a.stage] = a.date;

  // --- 3. Walk forward, crossing shifted thresholds.
  const crossings = {};
  for (const s of stages) crossings[s] = null;

  const seasonEnd = `${plantedDate.slice(0, 4)}-${SEASON_END_MONTH_DAY}`;
  let total = 0;
  let remaining = stages.filter(s => !observedByStage[s]).length;
  for (
    let d = addDays(plantedDate, 1);
    d <= seasonEnd && remaining > 0;
    d = addDays(d, 1)
  ) {
    const { gdd, kind } = gddForDate(d, weatherByDate, todayDate);
    total += gdd;
    for (const s of stages) {
      if (crossings[s] || observedByStage[s]) continue;
      if (total >= thresholds[s] + offset) {
        crossings[s] = { date: d, source: kind };
        remaining--;
      }
    }
  }

  for (const s of stages) {
    if (observedByStage[s]) {
      crossings[s] = { date: observedByStage[s], source: 'actual', observed: true };
    }
  }

  const gddToToday = todayDate > plantedDate
    ? accumulateGDD(plantedDate, weatherByDate, todayDate, todayDate)
    : 0;

  return { crossings, offset, anchorUsed, gddToToday };
}

module.exports = {
  dailyGDD,
  seasonalGDDForDate,
  gddForDate,
  accumulateGDD,
  projectCrossings,
  addDays,
  daysBetween,
  isValidDateStr,
};
