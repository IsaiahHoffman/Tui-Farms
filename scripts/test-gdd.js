// ============================================================================
// scripts/test-gdd.js — sanity checks for the GDD math in lib/gdd.js.
// Run with:  node scripts/test-gdd.js   (exits non-zero if anything fails)
// ============================================================================
const gdd = require('../lib/gdd');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    failures++;
    console.error(`FAIL  ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok    ${label}`);
  }
}
function checkClose(label, actual, expected, tol = 1e-9) {
  const pass = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  if (!pass) {
    failures++;
    console.error(`FAIL  ${label}\n      expected: ~${expected}\n      actual:   ${actual}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

// Synthetic weather: every day tmax 80 / tmin 70 -> (80+70)/2 - 50 = 25 GDD/day
function constantWeather(startDate, days) {
  const byDate = {};
  let d = startDate;
  for (let i = 0; i < days; i++) {
    byDate[d] = { max: 80, min: 70 };
    d = gdd.addDays(d, 1);
  }
  return byDate;
}

// ---------- dailyGDD ----------
checkClose('dailyGDD plain 80/70 = 25', gdd.dailyGDD(80, 70), 25);
checkClose('dailyGDD caps tmax at 86: 96/70 -> 28', gdd.dailyGDD(96, 70), 28);
checkClose('dailyGDD floors tmin at 50: 60/40 -> 5', gdd.dailyGDD(60, 40), 5);
checkClose('dailyGDD never negative: 48/40 -> 0', gdd.dailyGDD(48, 40), 0);

// ---------- seasonal fallback interpolation ----------
checkClose('seasonal at Aug 15 anchor = 22', gdd.seasonalGDDForDate('2026-08-15'), 22);
checkClose('seasonal before Aug 15 clamps to 22', gdd.seasonalGDDForDate('2026-06-01'), 22);
checkClose('seasonal at Nov 1 anchor = 3', gdd.seasonalGDDForDate('2026-11-01'), 3);
checkClose('seasonal after Nov 1 clamps to 3', gdd.seasonalGDDForDate('2026-12-15'), 3);
// Halfway between Sep 1 (19) and Sep 15 (15): Sep 8 -> 17
checkClose('seasonal interpolates: Sep 8 -> 17', gdd.seasonalGDDForDate('2026-09-08'), 17);

// ---------- accumulation starts the day AFTER planting ----------
{
  const weather = constantWeather('2026-06-01', 60);
  // planted Jun 1 -> Jun 1 counts 0; through Jun 5 = Jun 2,3,4,5 = 4 days * 25
  checkClose('accumulateGDD skips planting day', gdd.accumulateGDD('2026-06-01', weather, '2026-06-05', '2026-07-01'), 100);
}

// ---------- crossings at predictable day counts ----------
{
  const weather = constantWeather('2026-06-01', 120);
  const today = '2026-06-20';
  const { crossings } = gdd.projectCrossings('2026-06-01', weather, { early: 100, prime: 200 }, today);
  // 25/day starting Jun 2: 100 GDD on Jun 5 (day 4), 200 GDD on Jun 9 (day 8)
  check('threshold 100 crosses on day 4 (Jun 5)', crossings.early, { date: '2026-06-05', source: 'actual' });
  check('threshold 200 crosses on day 8 (Jun 9)', crossings.prime, { date: '2026-06-09', source: 'actual' });
}

// ---------- source labels: actual -> forecast -> seasonal-estimate ----------
{
  // Weather (actual+forecast) exists Jun 2..Jun 11 only; today is Jun 5.
  const weather = constantWeather('2026-06-02', 10);
  const today = '2026-06-05';
  const thresholds = { a: 100, b: 200, c: 500 };
  const { crossings } = gdd.projectCrossings('2026-06-01', weather, thresholds, today);
  check('crossing inside measured days = actual', crossings.a, { date: '2026-06-05', source: 'actual' });
  check('crossing inside forecast days = forecast', crossings.b, { date: '2026-06-09', source: 'forecast' });
  // After Jun 11 the seasonal table takes over (June clamps to 22/day):
  // through Jun 11: 10*25 = 250; need 250 more -> ceil(250/22) = 12 days -> Jun 23
  check('crossing beyond weather = seasonal-estimate', crossings.c, { date: '2026-06-23', source: 'seasonal-estimate' });
}

// ---------- anchor shifts the remaining crossings ----------
{
  const weather = constantWeather('2026-06-01', 120);
  const today = '2026-06-20';
  const thresholds = { early: 100, prime: 200 };
  // Un-anchored, early crosses Jun 5. The farmer actually saw "early" on
  // Jun 7, when accumulated GDD was 6*25 = 150. Offset = 150 - 100 = +50:
  // this block needs 50 more GDD than book value, so prime moves from
  // 200 -> 250 GDD, i.e. Jun 9 -> Jun 11 (10 days * 25 = 250).
  const anchors = [{ date: '2026-06-07', stage: 'early' }];
  const { crossings, offset } = gdd.projectCrossings('2026-06-01', weather, thresholds, today, anchors);
  checkClose('anchor offset = +50', offset, 50);
  check('anchored stage reports observed date', crossings.early, { date: '2026-06-07', source: 'actual', observed: true });
  check('later crossing shifted by the offset', crossings.prime, { date: '2026-06-11', source: 'actual' });
}

// ---------- latest anchor wins ----------
{
  const weather = constantWeather('2026-06-01', 120);
  const thresholds = { early: 100, prime: 200, mature: 300 };
  const anchors = [
    { date: '2026-06-07', stage: 'early' },  // offset would be +50
    { date: '2026-06-08', stage: 'prime' },  // 7*25=175 -> offset -25 (wins)
  ];
  const { crossings, offset } = gdd.projectCrossings('2026-06-01', weather, thresholds, '2026-06-20', anchors);
  checkClose('latest anchor wins: offset = -25', offset, -25);
  // mature: 300 - 25 = 275 GDD -> ceil(275/25) = 11 days -> Jun 12
  check('remaining crossing uses the winning offset', crossings.mature, { date: '2026-06-12', source: 'actual' });
}

// ---------- unreachable threshold returns null ----------
{
  // Planted Oct 20 with no weather: the seasonal fallback tapers to 3/day and
  // the projection stops at Dec 1 of the planting year, so a 1700-GDD
  // threshold can never be reached -> null, not a nonsense spring date.
  const { crossings } = gdd.projectCrossings('2026-10-20', {}, { early: 1700 }, '2026-10-21');
  check('unreachable threshold is null', crossings.early, null);
}

// ----------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll GDD checks passed.');
