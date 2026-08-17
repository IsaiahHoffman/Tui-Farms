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
