const admin = require("firebase-admin");

let initialized = false;

function getDb() {
  if (!initialized) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:    process.env.FIREBASE_PROJECT_ID,
        clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:   process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    initialized = true;
  }
  return admin.database();
}

// Write raw poll snapshot for one item
async function writeRaw(country, itemName, data) {
  const db  = getDb();
  const ts  = Date.now();
  const ref = db.ref(`raw/${country}/${sanitize(itemName)}/${ts}`);
  await ref.set({ ...data, ts });
}

// Write analysis summary for one item
async function writeAnalysis(country, itemName, analysis) {
  const db  = getDb();
  const ref = db.ref(`analysis/${sanitize(country)}/${sanitize(itemName)}`);
  await ref.set({ ...analysis, lastUpdated: Date.now() });
}

// Read last N raw snapshots for one item
async function readHistory(country, itemName, limitN = 120) {
  const db  = getDb();
  const ref = db.ref(`raw/${sanitize(country)}/${sanitize(itemName)}`);
  const snap = await ref.orderByKey().limitToLast(limitN).once("value");
  const val  = snap.val();
  if (!val) return [];
  return Object.values(val).sort((a, b) => a.ts - b.ts);
}

// Read analysis for one item
async function readAnalysis(country, itemName) {
  const db  = getDb();
  const ref = db.ref(`analysis/${sanitize(country)}/${sanitize(itemName)}`);
  const snap = await ref.once("value");
  return snap.val();
}

// Read all analysis for a country
async function readCountryAnalysis(country) {
  const db  = getDb();
  const ref = db.ref(`analysis/${sanitize(country)}`);
  const snap = await ref.once("value");
  return snap.val() || {};
}

// Prune raw history older than 24 hours to save Firebase quota
async function pruneOldRaw(country, itemName) {
  const db      = getDb();
  const cutoff  = Date.now() - 24 * 60 * 60 * 1000;
  const ref     = db.ref(`raw/${sanitize(country)}/${sanitize(itemName)}`);
  const snap    = await ref.orderByKey().endAt(String(cutoff)).limitToLast(50).once("value");
  const val     = snap.val();
  if (!val) return;
  const updates = {};
  Object.keys(val).forEach(k => { updates[k] = null; });
  await ref.update(updates);
}

function sanitize(str) {
  return str.replace(/[.#$[\]/]/g, "_");
}

module.exports = { writeRaw, writeAnalysis, readHistory, readAnalysis, readCountryAnalysis, pruneOldRaw };
