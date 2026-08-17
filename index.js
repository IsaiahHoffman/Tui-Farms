var express = require('express');
const app = express()
const path = require('path')
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// View Engine Setup
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')

// ---------------- Data storage ----------------
// Runtime data lives in data/ (gitignored — the deploy script preserves it and
// seeds missing files from the committed data/*.example.* files).
const DATA_DIR = path.join(__dirname, 'data');
const BEEF_FILE = path.join(DATA_DIR, 'beefItems.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const DELIVERY_RATE_PER_MILE = 1.75; // $ per mile, one way

// Write JSON via a temp file + rename so a crash mid-write can never leave a
// half-written (corrupt) data file behind.
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Read + parse a JSON file. Any problem (missing file, bad JSON) returns the
// fallback instead of throwing, so a damaged data file can never crash a page.
async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Could not read ${path.basename(file)}: ${err.message}`);
    }
    return fallback;
  }
}

// One-time migration: the beef list used to live in beefItems.txt as CSV.
// If the JSON file is missing but the old txt exists, convert it on startup.
function migrateBeefTxtToJson() {
  const txtFile = path.join(DATA_DIR, 'beefItems.txt');
  try {
    if (fs.existsSync(BEEF_FILE) || !fs.existsSync(txtFile)) return;
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
    console.log(`Migrated ${items.length} items from beefItems.txt to beefItems.json`);
  } catch (err) {
    console.error('Could not migrate beefItems.txt — starting with an empty beef list:', err.message);
    try { writeJsonAtomic(BEEF_FILE, []); } catch (e) { console.error(e.message); }
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
    return { name, weightRange, price, quantity: Math.round(quantity) };
  });
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

function requireAdmin(req, res, next) {
  res.set("X-Robots-Tag", "noindex, nofollow");

  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return res
      .status(503)
      .send("Admin is disabled: set the ADMIN_PASSWORD environment variable on the server to enable it.");
  }
  const user = process.env.ADMIN_USER || "tui";

  const header = req.headers.authorization || "";
  let authorized = false;
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const colon = decoded.indexOf(":");
    const givenUser = colon >= 0 ? decoded.slice(0, colon) : decoded;
    const givenPass = colon >= 0 ? decoded.slice(colon + 1) : "";
    // Bitwise & (not &&) so both comparisons always run.
    authorized = safeEqual(givenUser, user) & safeEqual(givenPass, password);
  }

  if (!authorized) {
    res.set("WWW-Authenticate", 'Basic realm="Tui Farms Admin"');
    return res.status(401).send("Authentication required.");
  }
  next();
}

// Keep crawlers away from the admin pages
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    "User-agent: *\nDisallow: /admin-beef\nDisallow: /admin-produce\n"
  );
});

// ---------------- Pages ----------------

app.get('/', function (req, res) {
  res.render('home')
})

app.get('/beef', async (req, res) => {
  const items = await readBeefItems();
  res.render('beef', { items });
})

app.get('/produce', async (req, res) => {
  const products = await readProducts();
  res.render('produce', { products });
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
