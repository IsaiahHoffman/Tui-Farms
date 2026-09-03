// ============================================================================
// lib/frost.js — the frost-risk curve behind the corn cast (pure, no I/O).
//
// Answers "what's the chance a frost has hit by this date?" for the public
// calendar's frost-risk bar. The farmer's frost watch date is the coin flip
// (50%). The 10% and 90% dates default to two weeks either side — roughly how
// first-frost odds run around Manheim — and can be pinned in
// data/cornConfig.json as frostRisk.p10 / frostRisk.p90 (the admin frost form
// edits them). Between anchors the curve is a straight line; it leaves 0% two
// weeks before p10 and reaches 100% two weeks after p90.
// ============================================================================
const gdd = require('./gdd');

const DEFAULT_SPREAD_DAYS = 14; // p10 / p90 sit this far either side of p50
const TAIL_DAYS = 14;           // 0% before p10 and 100% after p90, by this much

/**
 * buildFrostRisk(frostWatch, override)
 *   frostWatch — "YYYY-MM-DD", the 50% date; null/invalid -> returns null
 *   override   — optional { p10, p90 } "YYYY-MM-DD"; each is used only when
 *                valid and on the right side of frostWatch
 *
 * Returns { p0, p10, p50, p90, p100, chanceOn(date) -> 0..100 }
 */
function buildFrostRisk(frostWatch, override) {
  if (!gdd.isValidDateStr(frostWatch)) return null;
  const p50 = frostWatch;
  const o = override && typeof override === 'object' ? override : {};
  const p10 = gdd.isValidDateStr(o.p10) && o.p10 < p50
    ? o.p10 : gdd.addDays(p50, -DEFAULT_SPREAD_DAYS);
  const p90 = gdd.isValidDateStr(o.p90) && o.p90 > p50
    ? o.p90 : gdd.addDays(p50, DEFAULT_SPREAD_DAYS);
  const p0 = gdd.addDays(p10, -TAIL_DAYS);
  const p100 = gdd.addDays(p90, TAIL_DAYS);
  const points = [[p0, 0], [p10, 10], [p50, 50], [p90, 90], [p100, 100]];

  function chanceOn(date) {
    if (!gdd.isValidDateStr(date) || date <= p0) return 0;
    if (date >= p100) return 100;
    for (let i = 1; i < points.length; i++) {
      const [d1, c1] = points[i];
      if (date <= d1) {
        const [d0, c0] = points[i - 1];
        const span = Math.max(1, gdd.daysBetween(d0, d1));
        return c0 + (c1 - c0) * (gdd.daysBetween(d0, date) / span);
      }
    }
    return 100;
  }

  return { p0, p10, p50, p90, p100, chanceOn };
}

// A chance as customers read it: "under 5%", "~35%", "over 95%".
function chanceLabel(chance) {
  if (chance < 5) return 'under 5%';
  if (chance > 95) return 'over 95%';
  return '~' + (Math.round(chance / 5) * 5) + '%';
}

module.exports = { buildFrostRisk, chanceLabel, DEFAULT_SPREAD_DAYS };
