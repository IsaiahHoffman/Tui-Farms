// ============================================================================
// scripts/test-gdd.js — sanity checks for the GDD math in lib/gdd.js and the
// cast assembly in lib/corncast.js.
// Run with:  node scripts/test-gdd.js   (exits non-zero if anything fails)
// ============================================================================
const gdd = require('../lib/gdd');
const corncast = require('../lib/corncast');

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

// ---------- deriveThresholds: prime-centric variety schema ----------
check('deriveThresholds with donePlusGDD',
  gdd.deriveThresholds({ primeGDD: 1800, earlyMinusGDD: 100, freezerPlusGDD: 70, donePlusGDD: 160 }),
  { early: 1700, prime: 1800, mature: 1870, done: 1960 });
check('deriveThresholds null donePlusGDD -> freezer-best + 80',
  gdd.deriveThresholds({ primeGDD: 1650, earlyMinusGDD: 100, freezerPlusGDD: 70, donePlusGDD: null }),
  { early: 1550, prime: 1650, mature: 1720, done: 1800 });

// ---------- corncast: frost race + unresolved blocks ----------
{
  const mkVariety = (name, prime) => ({
    name, primeGDD: prime, earlyMinusGDD: 100, freezerPlusGDD: 70, donePlusGDD: null,
    notes: '', confidence: 'test',
  });
  const mkPlanting = (id, planted, variety = 'V') => ({
    id, label: id, variety, plantedDate: planted, acres: 1,
    status: 'standing', public: true, anchors: [],
  });

  // A planting whose thresholds can never be reached before the seasonal
  // table floor (planted 7/21, no weather at all, prime 1830) must still
  // appear in the cast — as a frost race, never silently dropped.
  {
    const cast = corncast.buildCornCast(
      [mkVariety('V', 1830)], [mkPlanting('late', '2026-07-21')],
      {}, '2026-08-18', '2026-10-15'
    );
    check('unreachable block still present in cast', cast.blocks.length, 1);
    check('unreachable block is a frost race', cast.blocks[0].state, 'frost-race');
    check('frost-race block gets no stage bar', cast.blocks[0].segments, null);
  }

  // Same planting with NO frost date configured: still never silently dropped.
  {
    const cast = corncast.buildCornCast(
      [mkVariety('V', 1830)], [mkPlanting('late', '2026-07-21')],
      {}, '2026-08-18', null
    );
    check('unresolved block is a frost race even without a frost date',
      cast.blocks[0].state, 'frost-race');
  }

  // A block that RESOLVES but lands past the frost date is also a frost race.
  {
    const weather = constantWeather('2026-06-01', 200); // 25 GDD/day
    // early = 3000-100 = 2900 GDD -> day 116 -> Sep 25, after Sep 15 frost.
    const cast = corncast.buildCornCast(
      [mkVariety('V', 3000)], [mkPlanting('slow', '2026-06-01')],
      weather, '2026-06-10', '2026-09-15'
    );
    check('early crossing after frost date -> frost race', cast.blocks[0].state, 'frost-race');
    const line = corncast.buildCornCast(
      [mkVariety('V', 3000)], [mkPlanting('slow', '2026-06-01')],
      weather, '2026-06-10', '2026-09-15'
    ).seasonLine;
    check('frost-race-only season line is honest',
      typeof line === 'string' && line.includes('racing the fall frost'), true);
  }

  // A normal block whose window reaches past the frost date: season line caps
  // at "~mid-Month, weather permitting" and the last bar segment is capped.
  {
    const weather = constantWeather('2026-06-01', 200);
    // Thresholds: early 100 (Jun 5), prime 200 (Jun 9), mature 270 (Jun 12),
    // done 350 (Jun 15) at 25 GDD/day. Frost Jun 8: the fresh segment
    // straddles the cutoff, prime and freezer sit entirely past it.
    const cast = corncast.buildCornCast(
      [mkVariety('V', 200)], [mkPlanting('b', '2026-06-01')],
      weather, '2026-06-06', '2026-06-08'
    );
    check('season line capped at frost',
      cast.seasonLine.includes('~early-June, weather permitting'), true);
    const segs = cast.blocks[0].segments;
    check('straddling segment keeps its start date',
      segs[0].datesLabel, 'Jun 5 – …weather permitting');
    check('fully post-frost segments are capped',
      [segs[1].datesLabel, segs[2].datesLabel],
      ['…weather permitting', '…weather permitting']);
  }

  // ---------- variety calendar (lib/calendar.js) ----------
  // Thresholds for prime 200: early 100 (day 4), done 350 (day 14) at 25/day,
  // so each planting spans plantedDate+4 .. plantedDate+14.
  {
    const calendar = require('../lib/calendar');
    const weather = constantWeather('2026-06-01', 200);
    const varieties = [mkVariety('V', 200)];
    const build = (plantings, today, frost) => calendar.buildVarietyCalendar(
      corncast.buildCornCast(varieties, plantings, weather, today, frost).blocks,
      today, frost
    );

    // Merge logic: A(6/1: Jun 5-15) overlaps B(6/5: Jun 9-19); C(6/20:
    // Jun 24-Jul 4) sits exactly 4 empty days after B -> all one bar.
    // D(7/10: Jul 14-24) sits 9 days out -> its own bar.
    const cal = build([
      mkPlanting('A', '2026-06-01'), mkPlanting('B', '2026-06-05'),
      mkPlanting('C', '2026-06-20'), mkPlanting('D', '2026-07-10'),
    ], '2026-06-06', null);
    check('one lane for one variety', cal.lanes.length, 1);
    check('overlap and 4-day gap merge; 9-day gap splits',
      cal.lanes[0].segments.map(s => [s.id, s.start, s.end]),
      [['v-1', '2026-06-05', '2026-07-04'], ['v-2', '2026-07-14', '2026-07-24']]);
    check('per-segment planting partitioning (early bar excludes late block)',
      cal.lanes[0].segments.map(s => s.plantings.map(p => p.label)),
      [['A', 'B', 'C'], ['D']]);
    check('axis has month ticks and a today line',
      cal.axis.months.length > 0 && cal.axis.today !== null, true);
    // Axis starts May 29 here; Jun 1's tick sits <6% in, so no partial label.
    check('leading partial label suppressed when the first tick is close',
      [cal.axis.months[0].label, cal.axis.months[0].partial === true],
      ['Jun', false]);

    // Mid-month axis start with room before the first tick: the leading
    // region gets a partial month label at the axis's left edge.
    const leading = build([mkPlanting('A', '2026-06-10')], '2026-06-11', null);
    check('leading partial month label at the axis edge',
      [leading.axis.months[0].pct, leading.axis.months[0].label, leading.axis.months[0].partial],
      [0, 'Jun', true]);

    // Frost cap: projected end Jun 15 with frost Jun 10 -> drawn to the frost
    // line, flagged, and labeled "weather permitting" (never a concrete date).
    const capped = build([mkPlanting('A', '2026-06-01')], '2026-06-06', '2026-06-10');
    const seg = capped.lanes[0].segments[0];
    check('frost-capped segment keeps its real end but is flagged',
      [seg.frostCapped, seg.end, seg.endLabel],
      [true, '2026-06-15', '~early-June, weather permitting']);
    checkClose('past share of the drawn bar', seg.pastPct, 20);
    check('frost line is on the axis', capped.axis.frost.label, 'frost watch ~Jun 10');

    // An ACTUAL end past the frost date is history — never capped.
    const history = build([mkPlanting('A', '2026-06-01')], '2026-06-20', '2026-06-10');
    check('actual end never frost-capped',
      [history.lanes[0].segments[0].frostCapped, history.lanes[0].segments[0].endLabel],
      [false, 'Jun 15']);

    // A frost-race block renders as a dashed chip segment in its lane.
    const twoVar = [mkVariety('V', 200), mkVariety('W', 6000)];
    const cast2 = corncast.buildCornCast(twoVar, [
      mkPlanting('A', '2026-06-01', 'V'),
      mkPlanting('LATE', '2026-06-01', 'W'), // 5900 GDD never resolves
    ], weather, '2026-06-06', '2026-06-10');
    const cal2 = calendar.buildVarietyCalendar(cast2.blocks, '2026-06-06', '2026-06-10');
    const wLane = cal2.lanes.find(l => l.variety === 'W');
    check('frost-race block appears as a chip segment',
      [wLane.segments.length, wLane.segments[0].id, wLane.segments[0].frostRace],
      [1, 'w-frost', true]);
    check('chip popover lists its plantings',
      wLane.segments[0].plantings.map(p => [p.label, p.frostRace]), [['LATE', true]]);
  }

  check('frostPhrase mid-month', corncast.frostPhrase('2026-10-15'), 'mid-October');
  check('frostPhrase early/late', [corncast.frostPhrase('2026-10-05'), corncast.frostPhrase('2026-10-25')],
    ['early-October', 'late-October']);
}

// ----------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll GDD checks passed.');
