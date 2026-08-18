// ============================================================================
// lib/jsonstore.js — the two little helpers every JSON data file goes through.
// ============================================================================
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

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

module.exports = { writeJsonAtomic, readJsonFile };
