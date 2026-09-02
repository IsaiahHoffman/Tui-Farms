var express = require('express');
const app = express()
const path = require('path')
const fs = require("fs");
const crypto = require("crypto");
const { writeJsonAtomic, readJsonFile } = require('./lib/jsonstore');
const gdd = require('./lib/gdd');
const corncast = require('./lib/corncast');
const { buildVarietyCalendar } = require('./lib/calendar');
const beefCatalog = require('./lib/beef');
const { getWeather, todayAtFarm } = require('./lib/weather');
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Every page needs its own canonical URL for the og:url meta tag
// (see views/partials/head.ejs).
app.use((req, res, next) => {
  res.locals.pagePath = req.path;
  next();
});

// View Engine Setup
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')

// ---------------- Data storage ----------------
// Runtime data lives in data/ (gitignored — the deploy script preserves it and
// seeds missing files from the committed data/*.example.* files).
const DATA_DIR = path.join(__dirname, 'data');
const BEEF_FILE = path.join(DATA_DIR, 'beefItems.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const VARIETIES_FILE = path.join(DATA_DIR, 'varieties.json');
const PLANTINGS_FILE = path.join(DATA_DIR, 'plantings.json');
const CORN_CONFIG_FILE = path.join(DATA_DIR, 'cornConfig.json');
const DELIVERY_RATE_PER_MILE = 2.50; // $ per mile, one way

// One-time migration: the beef list used to live in beefItems.txt as CSV.
// While that file exists it IS the live inventory, so it always wins — even
// over a beefItems.json a deploy may have seeded from the example file.
// After a successful migration the txt is renamed to beefItems.txt.migrated,
// which is what makes this truly one-time: it can never run again and
// clobber later edits made from the admin page.
function migrateBeefTxtToJson() {
  const txtFile = path.join(DATA_DIR, 'beefItems.txt');
  try {
    if (!fs.existsSync(txtFile)) return;
    const lines = fs.readFileSync(txtFile, 'utf-8').trim().split('\n');
    lines.shift(); // drop the CSV header row
    const items = lines
      .map(line => {
        const [name, weightRange, price, quantity] = line.split(',');
        return {
          name: (name || '').trim(),
          weightRange: (weightRange || '').trim(),
          price: Number(price) || 0,
          quantity: Number(quantity) || 0,
        };
      })
      .filter(item => item.name);
    writeJsonAtomic(BEEF_FILE, items);
    fs.renameSync(txtFile, txtFile + '.migrated');
    console.log(`Migrated ${items.length} items from beefItems.txt to beefItems.json`);
  } catch (err) {
    // Leave the txt in place untouched so nothing is lost; the site runs on
    // whatever beefItems.json holds and the next restart tries again.
    console.error('Could not migrate beefItems.txt — leaving it in place:', err.message);
  }
}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error(e.message); }
migrateBeefTxtToJson();

// Keep only well-formed rows; skip anything malformed rather than crash.
function cleanBeefItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(item => item && typeof item === 'object' && String(item.name || '').trim())
    .map(item => ({
      name: String(item.name).trim(),
      weightRange: String(item.weightRange ?? '').trim(),
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 0,
      // Optional category ("ground" | "steaks" | "roasts"); anything else is
      // treated as absent and the page falls back to name-based inference.
      ...(beefCatalog.BEEF_CATEGORY_SLUGS.includes(item.category)
        ? { category: item.category }
        : {}),
    }));
}

async function readBeefItems() {
  return cleanBeefItems(await readJsonFile(BEEF_FILE, []));
}

// ---------------- Produce products ----------------
const PRODUCT_STATUSES = ['in-season', 'coming', 'done'];

// Keep only well-formed products; skip anything malformed rather than crash.
function cleanProducts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => p && typeof p === 'object' && String(p.slug || '').trim() && String(p.name || '').trim())
    .map(p => ({
      slug: String(p.slug).trim(),
      name: String(p.name).trim(),
      emoji: String(p.emoji ?? '').trim(),
      status: PRODUCT_STATUSES.includes(p.status) ? p.status : 'done',
      statusNote: String(p.statusNote ?? '').trim(),
      pricing: Array.isArray(p.pricing)
        ? p.pricing
            .filter(row => row && typeof row === 'object')
            .map(row => ({
              label: String(row.label ?? '').trim(),
              price: String(row.price ?? '').trim(),
            }))
        : [],
      seasonNote: String(p.seasonNote ?? '').trim(),
      blurb: String(p.blurb ?? '').trim(),
    }));
}

async function readProducts() {
  return cleanProducts(await readJsonFile(PRODUCTS_FILE, []));
}

// Strict validation for the produce admin save. The form only edits status,
// statusNote, pricing, and blurb — everything else (name, emoji, seasonNote,
// product order) is kept from what is already on disk, matched by slug.
function validateProductEdits(raw, existing) {
  if (!Array.isArray(raw)) throw new Error('Expected a list of products.');
  const bySlug = new Map(existing.map(p => [p.slug, p]));
  const seen = new Set();
  for (const edit of raw) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      throw new Error('Each product must be an object.');
    }
    const slug = String(edit.slug ?? '').trim();
    const current = bySlug.get(slug);
    if (!current) throw new Error(`Unknown product "${slug || '(missing slug)'}".`);
    if (seen.has(slug)) throw new Error(`Product "${slug}" appears twice.`);
    seen.add(slug);

    if (!PRODUCT_STATUSES.includes(edit.status)) {
      throw new Error(`"${current.name}" — status must be one of: ${PRODUCT_STATUSES.join(', ')}.`);
    }
    const statusNote = String(edit.statusNote ?? '').trim();
    const blurb = String(edit.blurb ?? '').trim();
    if (statusNote.length > 200) throw new Error(`"${current.name}" — status note is capped at 200 characters.`);
    if (blurb.length > 1000) throw new Error(`"${current.name}" — blurb is capped at 1000 characters.`);

    if (!Array.isArray(edit.pricing)) throw new Error(`"${current.name}" — pricing must be a list.`);
    if (edit.pricing.length > 10) throw new Error(`"${current.name}" — pricing is capped at 10 rows.`);
    const pricing = edit.pricing.map((row, i) => {
      if (!row || typeof row !== 'object') throw new Error(`"${current.name}" — pricing row ${i + 1} is not valid.`);
      const label = String(row.label ?? '').trim();
      const price = String(row.price ?? '').trim();
      if (!label) throw new Error(`"${current.name}" — pricing row ${i + 1} needs a label.`);
      if (label.length > 60) throw new Error(`"${current.name}" — pricing labels are capped at 60 characters.`);
      if (price.length > 30) throw new Error(`"${current.name}" — pricing values are capped at 30 characters.`);
      return { label, price };
    });

    current.status = edit.status;
    current.statusNote = statusNote;
    current.pricing = pricing;
    current.blurb = blurb;
  }
  // Products missing from the submission simply keep their current values.
  return existing;
}

// Strict validation for the admin save. Throws a friendly Error (message is
// shown to the admin) on anything invalid.
function validateBeefItems(raw) {
  if (!Array.isArray(raw)) throw new Error('Expected a list of items.');
  if (raw.length > 100) throw new Error('Too many items — the list is capped at 100.');
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Row ${i + 1} is not a valid item.`);
    }
    const name = String(item.name ?? '').trim();
    const weightRange = String(item.weightRange ?? '').trim();
    if (!name) throw new Error(`Row ${i + 1} is missing a name.`);
    if (name.length > 80) throw new Error(`"${name.slice(0, 40)}…" — names are capped at 80 characters.`);
    if (weightRange.length > 40) throw new Error(`"${name}" — weight range is capped at 40 characters.`);
    const price = Number(item.price);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`"${name}" — price must be a number (0 or more).`);
    }
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error(`"${name}" — quantity must be a number (0 or more).`);
    }
    // Category: one of the known slugs, or empty/absent (stored absent so the
    // page falls back to name-based inference).
    const category = String(item.category ?? '').trim();
    if (category && !beefCatalog.BEEF_CATEGORY_SLUGS.includes(category)) {
      throw new Error(`"${name}" — category must be one of: ${beefCatalog.BEEF_CATEGORY_SLUGS.join(', ')} (or blank).`);
    }
    return {
      name, weightRange, price, quantity: Math.round(quantity),
      ...(category ? { category } : {}),
    };
  });
}

// ---------------- Corn cast: varieties + plantings ----------------
const PLANTING_STATUSES = ['standing', 'picking', 'done'];

// Keep only well-formed varieties; skip anything malformed rather than crash.
// Varieties are parameterized around PRIME (the stage the owner judges most
// confidently): primeGDD is absolute, the other stages are offsets from it.
// See lib/gdd.js deriveThresholds() for how they become absolute thresholds.
function cleanVarieties(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(v => v && typeof v === 'object'
      && String(v.name || '').trim()
      && Number.isFinite(v.primeGDD) && Number.isFinite(v.earlyMinusGDD) && Number.isFinite(v.freezerPlusGDD))
    .map(v => ({
      name: String(v.name).trim(),
      primeGDD: v.primeGDD,
      earlyMinusGDD: v.earlyMinusGDD,
      freezerPlusGDD: v.freezerPlusGDD,
      donePlusGDD: Number.isFinite(v.donePlusGDD) ? v.donePlusGDD : null,
      notes: String(v.notes ?? '').trim(),
      confidence: String(v.confidence ?? '').trim(),
    }));
}

// ---------------- Corn cast config (frost cutoff) ----------------
// data/cornConfig.json — small admin-editable settings for the cast.
// frostWatchDate: nothing is promised past this date; late blocks show as a
// "frost race". null disables the cutoff.
function cleanCornConfig(raw) {
  const config = { frostWatchDate: null, notes: '' };
  if (raw && typeof raw === 'object') {
    if (gdd.isValidDateStr(raw.frostWatchDate)) config.frostWatchDate = raw.frostWatchDate;
    config.notes = String(raw.notes ?? '').trim();
  }
  return config;
}

async function readCornConfig() {
  return cleanCornConfig(await readJsonFile(CORN_CONFIG_FILE, null));
}

// Keep only well-formed plantings; skip anything malformed rather than crash.
function cleanPlantings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => p && typeof p === 'object'
      && String(p.id || '').trim()
      && String(p.label || '').trim()
      && String(p.variety || '').trim()
      && gdd.isValidDateStr(p.plantedDate))
    .map(p => ({
      id: String(p.id).trim(),
      label: String(p.label).trim(),
      variety: String(p.variety).trim(),
      plantedDate: p.plantedDate,
      acres: Number.isFinite(p.acres) ? p.acres : 1,
      status: PLANTING_STATUSES.includes(p.status) ? p.status : 'standing',
      public: p.public !== false,
      anchors: Array.isArray(p.anchors)
        ? p.anchors.filter(a => a && gdd.isValidDateStr(a.date) && corncast.STAGES.includes(a.stage))
            .map(a => ({ date: a.date, stage: a.stage }))
        : [],
    }));
}

async function readVarieties() {
  return cleanVarieties(await readJsonFile(VARIETIES_FILE, []));
}

async function readPlantings() {
  return cleanPlantings(await readJsonFile(PLANTINGS_FILE, []));
}

// Validate the add/update planting form. Throws a friendly Error on anything
// invalid; returns the cleaned fields.
function validatePlantingForm(body, varieties, { withStatus }) {
  const label = String(body.label ?? '').trim();
  if (!label) throw new Error('A label is required (e.g. "Batch 3").');
  if (label.length > 60) throw new Error('Labels are capped at 60 characters.');

  const variety = String(body.variety ?? '').trim();
  if (!varieties.some(v => v.name === variety)) {
    throw new Error(`Unknown variety "${variety}" — add it in the varieties editor first.`);
  }

  const plantedDate = String(body.plantedDate ?? '').trim();
  if (!gdd.isValidDateStr(plantedDate)) throw new Error('Planted date must be YYYY-MM-DD.');
  if (plantedDate > gdd.addDays(todayAtFarm(), 1)) {
    throw new Error('Planted date cannot be more than 1 day in the future.');
  }

  const acres = Number(body.acres);
  if (!Number.isFinite(acres) || acres <= 0 || acres > 1000) {
    throw new Error('Acres must be a positive number.');
  }

  const isPublic = body.public === 'on' || body.public === 'true';

  let status = 'standing';
  if (withStatus) {
    status = String(body.status ?? '').trim();
    if (!PLANTING_STATUSES.includes(status)) {
      throw new Error(`Status must be one of: ${PLANTING_STATUSES.join(', ')}.`);
    }
  }

  return { label, variety, plantedDate, acres, public: isPublic, status };
}

// Validate the varieties editor save (same hidden-JSON pattern as admin-beef).
function validateVarieties(raw, existingVarieties, plantings) {
  if (!Array.isArray(raw)) throw new Error('Expected a list of varieties.');
  if (raw.length > 50) throw new Error('Too many varieties — the list is capped at 50.');
  const confidenceByName = new Map(existingVarieties.map(v => [v.name, v.confidence]));
  const seen = new Set();
  const cleaned = raw.map((v, i) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`Row ${i + 1} is not a valid variety.`);
    }
    const name = String(v.name ?? '').trim();
    if (!name) throw new Error(`Row ${i + 1} is missing a name.`);
    if (name.length > 60) throw new Error(`"${name.slice(0, 30)}…" — names are capped at 60 characters.`);
    if (seen.has(name)) throw new Error(`Variety "${name}" appears twice.`);
    seen.add(name);

    const num = (value, fieldLabel, max, { optional } = {}) => {
      if (optional && (value === null || value === undefined || String(value).trim() === '')) return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > max) {
        throw new Error(`"${name}" — ${fieldLabel} must be a number between 1 and ${max}.`);
      }
      return n;
    };
    const primeGDD = num(v.primeGDD, 'prime GDD', 10000);
    const earlyMinusGDD = num(v.earlyMinusGDD, '"early −" GDD', 2000);
    const freezerPlusGDD = num(v.freezerPlusGDD, '"freezer +" GDD', 2000);
    const donePlusGDD = num(v.donePlusGDD, '"done +" GDD', 2000, { optional: true });
    if (earlyMinusGDD >= primeGDD) {
      throw new Error(`"${name}" — "early −" must be smaller than the prime GDD itself.`);
    }
    if (donePlusGDD !== null && donePlusGDD <= freezerPlusGDD) {
      throw new Error(`"${name}" — "done +" must be greater than "freezer +" (or left blank).`);
    }
    const notes = String(v.notes ?? '').trim();
    if (notes.length > 500) throw new Error(`"${name}" — notes are capped at 500 characters.`);

    return {
      name, primeGDD, earlyMinusGDD, freezerPlusGDD, donePlusGDD, notes,
      confidence: confidenceByName.get(name) || 'farm',
    };
  });
  for (const p of plantings) {
    if (!cleaned.some(v => v.name === p.variety)) {
      throw new Error(`Variety "${p.variety}" is still used by planting "${p.label}" — update that planting first.`);
    }
  }
  return cleaned;
}

// Assemble the full corn cast (weather + math). Never throws — any problem
// returns null and the pages fall back to plain statusNote text.
async function getCornCast() {
  try {
    const [varieties, plantings] = await Promise.all([readVarieties(), readPlantings()]);
    if (varieties.length === 0 || plantings.length === 0) return null;
    const earliestPlanting = plantings.map(p => p.plantedDate).sort()[0];
    const [weather, cornConfig] = await Promise.all([getWeather(earliestPlanting), readCornConfig()]);
    // No weather data at all (no cache and the API is down): a cast built purely
    // from the seasonal fallback table would be misleading, so the public pages
    // fall back to the product's plain statusNote instead. (The admin page still
    // shows the seasonal-only projection, with a warning banner.)
    if (weather.degraded) return null;
    const today = todayAtFarm();
    const cast = corncast.buildCornCast(
      varieties, plantings, weather.byDate, today, cornConfig.frostWatchDate
    );
    return {
      ...cast, today,
      frostWatchDate: cornConfig.frostWatchDate,
      weatherDegraded: weather.degraded,
    };
  } catch (err) {
    console.error('Corn cast unavailable:', err.message);
    return null;
  }
}

// ---------------- Admin authentication ----------------
// HTTP Basic Auth for /admin-* routes. Credentials come from environment
// variables so nothing secret ever lives in this (public) repo:
//   ADMIN_USER     - optional, defaults to "tui"
//   ADMIN_PASSWORD - REQUIRED; if unset, admin pages are disabled entirely.
function safeEqual(a, b) {
  // Compare fixed-length hashes so string length is never leaked.
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Brute-force throttle: after this many wrong passwords from one address
// inside the window, further attempts get 429 until the window rolls over.
// (In-memory on purpose — a restart clearing it is fine for this site.)
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;
const authFailures = new Map(); // ip -> { count, windowStart }

function authFailureEntry(ip) {
  const entry = authFailures.get(ip);
  if (entry && Date.now() - entry.windowStart <= AUTH_WINDOW_MS) return entry;
  authFailures.delete(ip);
  return null;
}

function recordAuthFailure(ip) {
  const entry = authFailureEntry(ip);
  if (entry) {
    entry.count++;
  } else {
    // Bound the map so cycling through addresses can't grow it forever.
    if (authFailures.size >= 10000) authFailures.clear();
    authFailures.set(ip, { count: 1, windowStart: Date.now() });
  }
}

function requireAdmin(req, res, next) {
  res.set("X-Robots-Tag", "noindex, nofollow");

  const password = process.env.ADMIN_PASSWORD;
  // Too-short passwords fall to brute force fast enough that a weak secret is
  // treated the same as no secret: admin stays disabled.
  if (!password || password.length < 8) {
    return res
      .status(503)
      .send("Admin is disabled: set the ADMIN_PASSWORD environment variable (at least 8 characters) on the server to enable it.");
  }
  const user = process.env.ADMIN_USER || "tui";

  // CSRF guard for the form posts: browsers always attach an Origin header to
  // cross-site POSTs and a page cannot forge it, so any Origin that isn't this
  // site is rejected. (Requests without an Origin — curl, some same-site
  // navigations — pass through to the auth check below.)
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { /* malformed Origin */ }
      if (!originHost || originHost !== req.headers.host) {
        return res.status(403).send("Cross-site request rejected.");
      }
    }
  }

  const entry = authFailureEntry(req.ip);
  if (entry && entry.count >= AUTH_MAX_FAILURES) {
    const retryAfterSec = Math.ceil((entry.windowStart + AUTH_WINDOW_MS - Date.now()) / 1000);
    res.set("Retry-After", String(Math.max(1, retryAfterSec)));
    return res.status(429).send("Too many failed login attempts — try again later.");
  }

  const header = req.headers.authorization || "";
  const credentialsGiven = header.startsWith("Basic ");
  let authorized = false;
  if (credentialsGiven) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const colon = decoded.indexOf(":");
    const givenUser = colon >= 0 ? decoded.slice(0, colon) : decoded;
    const givenPass = colon >= 0 ? decoded.slice(colon + 1) : "";
    // Bitwise & (not &&) so both comparisons always run.
    authorized = safeEqual(givenUser, user) & safeEqual(givenPass, password);
  }

  if (!authorized) {
    // Only WRONG credentials count toward the throttle — the credential-less
    // 401 that opens the browser's login prompt is part of every normal login.
    if (credentialsGiven) recordAuthFailure(req.ip);
    res.set("WWW-Authenticate", 'Basic realm="Tui Farms Admin"');
    return res.status(401).send("Authentication required.");
  }
  authFailures.delete(req.ip);
  next();
}

// Keep crawlers away from the admin pages
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    "User-agent: *\nDisallow: /admin-beef\nDisallow: /admin-produce\nDisallow: /admin-plantings\n"
  );
});

// "0.375-0.5" or ".375-.5" or "1" × price/lb -> "about $13.50–$18 each".
// Returns null when the weight range can't be parsed — the page just skips
// the estimate line in that case.
function packageEstimate(weightRange, price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const text = String(weightRange || '').trim();
  const range = text.match(/^(\d*\.?\d+)\s*[-–]\s*(\d*\.?\d+)$/);
  const single = text.match(/^(\d*\.?\d+)$/);
  let lo, hi;
  if (range) {
    lo = parseFloat(range[1]);
    hi = parseFloat(range[2]);
  } else if (single) {
    lo = hi = parseFloat(single[1]);
  } else {
    return null;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return null;
  if (lo > hi) [lo, hi] = [hi, lo];
  const dollars = lbs => {
    const value = lbs * price;
    return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
  };
  return lo === hi
    ? `about ${dollars(lo)} each`
    : `about ${dollars(lo)}–${dollars(hi)} each`;
}

// ---------------- Pages ----------------

app.get('/', async (req, res) => {
  const [beefItems, products] = await Promise.all([readBeefItems(), readProducts()]);
  const beefInStock = beefItems.filter(item => item.quantity > 0).length;
  const cast = await getCornCast();
  res.render('home', { beefInStock, products, cornLine: cast ? cast.seasonLine : null });
})

app.get('/beef', async (req, res) => {
  const items = (await readBeefItems()).map(item => ({
    ...item,
    estimate: packageEstimate(item.weightRange, item.price),
    // "everyday best value" applies only to the item literally named so —
    // the owner's traffic draw, not every ground product.
    bestValue: item.name === 'Ground Beef',
    onlyOne: item.quantity === 1,
    orderHref: 'sms:7178031649?&body='
      + encodeURIComponent(`Hi Tui Farms! I'd like to order: ${item.name}`),
  }));
  const available = items.filter(item => item.quantity > 0);
  // In-stock items render grouped into customer-friendly category sections.
  const sections = beefCatalog.groupBeefSections(available);
  // "Cuts we carry when in stock" is a name list, so drop duplicates and
  // anything that is already shown as available under the same name.
  const shownNames = new Set(available.map(item => item.name.toLowerCase()));
  const outOfStock = items.filter(item => {
    if (item.quantity > 0) return false;
    const key = item.name.toLowerCase();
    if (shownNames.has(key)) return false;
    shownNames.add(key);
    return true;
  });
  res.render('beef', {
    sections,
    anyAvailable: available.length > 0,
    outOfStock,
  });
})

// Bulk beef — halves & wholes: its own page, like a produce product.
app.get('/beef/bulk', (req, res) => {
  res.render('beef-bulk', {
    reserveHref: 'sms:7178031649?&body='
      + encodeURIComponent("Hi Tui Farms! I'd like to reserve a half/whole beef."),
  });
})

app.get('/produce', async (req, res) => {
  const products = await readProducts();
  const cast = await getCornCast();
  res.render('produce', { products, cornLine: cast ? cast.seasonLine : null });
})

// The corn cast page — sweet corn harvest forecast
app.get('/produce/sweet-corn', async (req, res) => {
  const products = await readProducts();
  const product = products.find(p => p.slug === 'sweet-corn') || null;
  const cast = await getCornCast();
  const calendar = cast
    ? buildVarietyCalendar(cast.blocks, cast.today, cast.frostWatchDate)
    : null;
  // ?open=<segmentId> server-renders that bar's popover open — a no-JS
  // fallback that also makes static screenshots possible.
  const openId = String(req.query.open || '').slice(0, 60);
  res.render('corn-cast', {
    product,
    seasonLine: cast ? cast.seasonLine : null,
    calendar,
    openId,
  });
})

app.get('/corn', (req, res) => {
  res.redirect('/produce/sweet-corn');
})

app.get('/our-farm', (req, res) => {
  res.render('our-farm');
})

app.get('/contact', (req, res) => {
  const exampleMiles = 10;
  res.render('contact', {
    deliveryRate: DELIVERY_RATE_PER_MILE,
    deliveryExample: {
      miles: exampleMiles,
      cost: (exampleMiles * DELIVERY_RATE_PER_MILE).toFixed(2),
    },
  });
})

// ---------------- Admin pages ----------------

app.get("/admin-beef", requireAdmin, async (req, res) => {
  const items = await readBeefItems();
  res.render("admin-beef", { items, message: null, messageType: null });
});

app.post("/admin-beef", requireAdmin, async (req, res) => {
  let items;
  try {
    const parsed = JSON.parse(req.body.itemsJSON);
    items = validateBeefItems(parsed);
  } catch (err) {
    const current = await readBeefItems();
    return res.status(400).render("admin-beef", {
      items: current,
      message: "Nothing was saved — " + err.message,
      messageType: "error",
    });
  }
  writeJsonAtomic(BEEF_FILE, items);
  res.render("admin-beef", {
    items,
    message: "✅ Successfully updated beef items list!",
    messageType: "success",
  });
});

app.get("/admin-produce", requireAdmin, async (req, res) => {
  const products = await readProducts();
  res.render("admin-produce", { products, message: null, messageType: null });
});

app.post("/admin-produce", requireAdmin, async (req, res) => {
  const existing = await readProducts();
  let products;
  try {
    const parsed = JSON.parse(req.body.productsJSON);
    products = validateProductEdits(parsed, existing);
  } catch (err) {
    const current = await readProducts();
    return res.status(400).render("admin-produce", {
      products: current,
      message: "Nothing was saved — " + err.message,
      messageType: "error",
    });
  }
  writeJsonAtomic(PRODUCTS_FILE, products);
  res.render("admin-produce", {
    products,
    message: "✅ Successfully updated produce info!",
    messageType: "success",
  });
});

// ---------------- Admin: plantings + varieties (corn cast) ----------------

// Shared renderer so every plantings POST can show the page with a message.
async function renderAdminPlantings(res, message, messageType, statusCode = 200) {
  const [varieties, plantings, cornConfig] = await Promise.all([
    readVarieties(), readPlantings(), readCornConfig(),
  ]);
  const earliestPlanting = plantings.map(p => p.plantedDate).sort()[0] || null;
  const weather = await getWeather(earliestPlanting);
  const today = todayAtFarm();
  const cast = corncast.buildCornCast(
    varieties, plantings, weather.byDate, today, cornConfig.frostWatchDate
  );
  const drift = corncast.buildDriftRows(varieties, plantings, weather.byDate, today);
  res.status(statusCode).render('admin-plantings', {
    varieties,
    blocks: cast.blocks,
    drift,
    today,
    cornConfig,
    weatherDegraded: weather.degraded,
    message: message || null,
    messageType: messageType || null,
  });
}

// Success POSTs redirect back here (so a page refresh can't double-submit);
// the message rides along in the query string.
app.get('/admin-plantings', requireAdmin, async (req, res) => {
  const message = String(req.query.msg || '').slice(0, 200) || null;
  const messageType = req.query.type === 'success' ? 'success' : (message ? 'error' : null);
  await renderAdminPlantings(res, message, messageType);
});

function redirectWithMessage(res, message) {
  res.redirect('/admin-plantings?type=success&msg=' + encodeURIComponent(message));
}

app.post('/admin-plantings/add', requireAdmin, async (req, res) => {
  try {
    const [varieties, plantings] = await Promise.all([readVarieties(), readPlantings()]);
    if (plantings.length >= 100) throw new Error('Too many plantings — the list is capped at 100.');
    const fields = validatePlantingForm(req.body, varieties, { withStatus: false });
    const id = 'p' + Date.now().toString(36);
    plantings.push({ id, ...fields, status: 'standing', anchors: [] });
    writeJsonAtomic(PLANTINGS_FILE, plantings);
    redirectWithMessage(res, `Added "${fields.label}".`);
  } catch (err) {
    await renderAdminPlantings(res, 'Nothing was saved — ' + err.message, 'error', 400);
  }
});

app.post('/admin-plantings/update', requireAdmin, async (req, res) => {
  try {
    const [varieties, plantings] = await Promise.all([readVarieties(), readPlantings()]);
    const planting = plantings.find(p => p.id === String(req.body.id || ''));
    if (!planting) throw new Error('That planting no longer exists.');
    const fields = validatePlantingForm(req.body, varieties, { withStatus: true });
    Object.assign(planting, fields); // anchors and id are kept as-is
    writeJsonAtomic(PLANTINGS_FILE, plantings);
    redirectWithMessage(res, `Updated "${fields.label}".`);
  } catch (err) {
    await renderAdminPlantings(res, 'Nothing was saved — ' + err.message, 'error', 400);
  }
});

app.post('/admin-plantings/delete', requireAdmin, async (req, res) => {
  try {
    const plantings = await readPlantings();
    const planting = plantings.find(p => p.id === String(req.body.id || ''));
    if (!planting) throw new Error('That planting no longer exists.');
    writeJsonAtomic(PLANTINGS_FILE, plantings.filter(p => p !== planting));
    redirectWithMessage(res, `Deleted "${planting.label}".`);
  } catch (err) {
    await renderAdminPlantings(res, 'Nothing was deleted — ' + err.message, 'error', 400);
  }
});

// One-tap field observation: "this block hit <stage> today".
// Forgiving by design — a second tap the same day replaces that day's anchor.
app.post('/admin-plantings/observe', requireAdmin, async (req, res) => {
  try {
    const plantings = await readPlantings();
    const planting = plantings.find(p => p.id === String(req.body.id || ''));
    if (!planting) throw new Error('That planting no longer exists.');
    const stage = String(req.body.stage || '');
    if (!corncast.STAGES.includes(stage)) throw new Error('Unknown stage.');
    const today = todayAtFarm();
    if (planting.plantedDate >= today) throw new Error('That block was only just planted.');
    planting.anchors = planting.anchors.filter(a => a.date !== today);
    planting.anchors.push({ date: today, stage });
    if (stage === 'done') planting.status = 'done';
    writeJsonAtomic(PLANTINGS_FILE, plantings);
    redirectWithMessage(res, `Logged: "${planting.label}" hit ${stage} today.`);
  } catch (err) {
    await renderAdminPlantings(res, 'Nothing was logged — ' + err.message, 'error', 400);
  }
});

app.post('/admin-plantings/anchor-delete', requireAdmin, async (req, res) => {
  try {
    const plantings = await readPlantings();
    const planting = plantings.find(p => p.id === String(req.body.id || ''));
    if (!planting) throw new Error('That planting no longer exists.');
    const date = String(req.body.date || '');
    const stage = String(req.body.stage || '');
    const before = planting.anchors.length;
    planting.anchors = planting.anchors.filter(a => !(a.date === date && a.stage === stage));
    if (planting.anchors.length === before) throw new Error('That observation no longer exists.');
    writeJsonAtomic(PLANTINGS_FILE, plantings);
    redirectWithMessage(res, `Removed the ${stage} observation from "${planting.label}".`);
  } catch (err) {
    await renderAdminPlantings(res, 'Nothing was removed — ' + err.message, 'error', 400);
  }
});

app.post('/admin-plantings/frost-config', requireAdmin, async (req, res) => {
  try {
    const dateInput = String(req.body.frostWatchDate ?? '').trim();
    if (dateInput && !gdd.isValidDateStr(dateInput)) {
      throw new Error('Frost watch date must be YYYY-MM-DD (or empty to disable).');
    }
    const notes = String(req.body.notes ?? '').trim();
    if (notes.length > 300) throw new Error('Frost notes are capped at 300 characters.');
    writeJsonAtomic(CORN_CONFIG_FILE, { frostWatchDate: dateInput || null, notes });
    redirectWithMessage(res, dateInput
      ? `Frost watch date set to ${dateInput}.`
      : 'Frost watch date cleared.');
  } catch (err) {
    await renderAdminPlantings(res, 'Nothing was saved — ' + err.message, 'error', 400);
  }
});

app.post('/admin-varieties', requireAdmin, async (req, res) => {
  try {
    const [varieties, plantings] = await Promise.all([readVarieties(), readPlantings()]);
    const parsed = JSON.parse(req.body.varietiesJSON);
    const cleaned = validateVarieties(parsed, varieties, plantings);
    writeJsonAtomic(VARIETIES_FILE, cleaned);
    redirectWithMessage(res, 'Updated varieties.');
  } catch (err) {
    await renderAdminPlantings(res, 'Nothing was saved — ' + err.message, 'error', 400);
  }
});

// ---------------- 404 + error handling ----------------

app.use((req, res) => {
  res.status(404).render('404');
});

// Final error handler — Express 5 forwards rejected promises here too.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('error');
});

app.listen(process.env.PORT || 80, function () {
  console.log('Port: ' + (process.env.PORT || 80));
});
