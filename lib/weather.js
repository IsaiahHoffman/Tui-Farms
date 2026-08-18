// ============================================================================
// lib/weather.js — daily max/min temperatures for the farm, cached on disk.
//
// Data source: Open-Meteo (free, no API key).
//   * archive API  — quality-controlled history (lags a few days behind)
//   * forecast API — 16-day forecast plus the last 21 days of measurements
// The two are merged into { "YYYY-MM-DD": { max, min, src } } and cached in
// data/weatherCache.json for 6 hours.
//
// Failure policy: the corn cast must NEVER take a page down or hang it.
//   * every fetch has a 10-second timeout
//   * any fetch failure serves the stale cache instead
//   * no cache at all -> return an empty set marked degraded; the pages fall
//     back to seasonal estimates / plain statusNote text
// ============================================================================
const path = require('path');
const { writeJsonAtomic, readJsonFile } = require('./jsonstore');

// Farm location: 2778 Spooky Nook Rd, Manheim PA
const LATITUDE = 40.106;
const LONGITUDE = -76.42;
const TIMEZONE = 'America/New_York';

// Env overrides exist only so tests can point at an unreachable host.
const ARCHIVE_BASE = process.env.WEATHER_ARCHIVE_BASE || 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_BASE = process.env.WEATHER_FORECAST_BASE || 'https://api.open-meteo.com/v1/forecast';

const CACHE_FILE = path.join(__dirname, '..', 'data', 'weatherCache.json');
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;   // refresh lazily after 6 hours
const FETCH_TIMEOUT_MS = 10 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;  // don't hammer a down API

let lastFailedFetchAt = 0;

// Today's date at the farm (America/New_York), as "YYYY-MM-DD".
// en-CA formats dates exactly that way.
function todayAtFarm() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Turn one Open-Meteo daily payload into { date: {max, min, src} } entries.
function collectDaily(payload, src, into) {
  const daily = payload && payload.daily;
  if (!daily || !Array.isArray(daily.time)) return;
  for (let i = 0; i < daily.time.length; i++) {
    const date = daily.time[i];
    const max = daily.temperature_2m_max[i];
    const min = daily.temperature_2m_min[i];
    if (typeof date === 'string' && Number.isFinite(max) && Number.isFinite(min)) {
      into[date] = { max, min, src };
    }
  }
}

/**
 * getWeather(earliestDate)
 *   earliestDate — "YYYY-MM-DD": how far back history is needed (usually the
 *                  earliest planting date). May be null when nothing is planted.
 *
 * Returns { byDate, fetchedAt, degraded }
 *   byDate   — { "YYYY-MM-DD": { max, min, src } }; may be {} when degraded
 *   degraded — true when there is no usable data at all
 */
async function getWeather(earliestDate) {
  const cache = await readJsonFile(CACHE_FILE, null);
  const cacheUsable = cache && cache.byDate && typeof cache.byDate === 'object';

  const cacheFresh = cacheUsable
    && Number.isFinite(Date.parse(cache.fetchedAt))
    && Date.now() - Date.parse(cache.fetchedAt) < CACHE_MAX_AGE_MS
    // if plantings now reach further back than the cache does, refresh anyway
    && (!earliestDate || (cache.earliestDate && cache.earliestDate <= earliestDate));

  if (cacheFresh) {
    return { byDate: cache.byDate, fetchedAt: cache.fetchedAt, degraded: false };
  }

  // A fetch failed very recently — serve what we have instead of retrying
  // on every page view.
  if (Date.now() - lastFailedFetchAt < RETRY_AFTER_FAILURE_MS) {
    return cacheUsable
      ? { byDate: cache.byDate, fetchedAt: cache.fetchedAt, degraded: false }
      : { byDate: {}, fetchedAt: null, degraded: true };
  }

  try {
    const today = todayAtFarm();
    const start = earliestDate || shiftDate(today, -120);
    const byDate = {};

    // Forecast first (also covers the last 21 days) ...
    const forecastUrl = `${FORECAST_BASE}?latitude=${LATITUDE}&longitude=${LONGITUDE}`
      + `&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit`
      + `&timezone=${encodeURIComponent(TIMEZONE)}&past_days=21&forecast_days=16`;
    collectDaily(await fetchJson(forecastUrl), 'forecast', byDate);

    // ... then the archive overwrites where it has quality-controlled data.
    // The archive lags a few days; end it safely in the recent past.
    const archiveEnd = shiftDate(today, -5);
    if (start <= archiveEnd) {
      const archiveUrl = `${ARCHIVE_BASE}?latitude=${LATITUDE}&longitude=${LONGITUDE}`
        + `&start_date=${start}&end_date=${archiveEnd}`
        + `&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit`
        + `&timezone=${encodeURIComponent(TIMEZONE)}`;
      collectDaily(await fetchJson(archiveUrl), 'archive', byDate);
    }

    if (Object.keys(byDate).length === 0) throw new Error('weather APIs returned no days');

    const fetchedAt = new Date().toISOString();
    writeJsonAtomic(CACHE_FILE, { fetchedAt, earliestDate: start, byDate });
    return { byDate, fetchedAt, degraded: false };
  } catch (err) {
    lastFailedFetchAt = Date.now();
    console.error('Weather fetch failed, serving cache:', err.message);
    return cacheUsable
      ? { byDate: cache.byDate, fetchedAt: cache.fetchedAt, degraded: false }
      : { byDate: {}, fetchedAt: null, degraded: true };
  }
}

module.exports = { getWeather, todayAtFarm };
