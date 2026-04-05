const admin = require("firebase-admin");

// ── Firebase (reuse app if already initialized) ───────────────────────────────
function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

function san(str) { return str.replace(/[.#$[\]/\s]/g, "_"); }

async function readAnalysis(country, itemName) {
  const snap = await getDb().ref(`analysis/${san(country)}/${san(itemName)}`).once("value");
  return snap.val();
}

async function readCountryAnalysis(country) {
  const snap = await getDb().ref(`analysis/${san(country)}`).once("value");
  return snap.val() || {};
}

async function readLatestRaw(country, itemName) {
  // Get the most recent raw snapshot — contains estimatedRestockMinutes from DroqsDB
  const snap = await getDb().ref(`raw/${san(country)}/${san(itemName)}`).orderByKey().limitToLast(1).once("value");
  const val  = snap.val();
  if (!val) return null;
  return Object.values(val)[0];
}

// ── shouldFly ─────────────────────────────────────────────────────────────────
function shouldFly(analysis, flightMins, buffer = 0) {
  if (!analysis || analysis.confidence < 0.3)
    return { fly: null, reason: "insufficient data", nextWindowMins: null };

  const { currentStock, stockRunway, nextRestockEta, avgRestockInterval, confidence } = analysis;

  // Apply safety buffer to stock duration
  const rawStockDuration = analysis.avgStockDuration;
  const avgStockDuration = rawStockDuration ? rawStockDuration + buffer : rawStockDuration;
  const bufferNote = buffer !== 0 && rawStockDuration
    ? ` (${rawStockDuration}m ${buffer}m buffer = ${avgStockDuration}m effective)`
    : "";

  // ── Stock available now ──────────────────────────────────────────────────
  if (currentStock > 0) {
    if (!stockRunway)
      return { fly: true, reason: "stock available, no depletion data", nextWindowMins: 0, confidence };
    if (stockRunway >= flightMins)
      return { fly: true, reason: `stock lasts ${stockRunway}m, flight=${flightMins}m`, nextWindowMins: 0, confidence };
    // Stock will deplete before landing — check if next restock window works
    const nextCycleEta = nextRestockEta || avgRestockInterval;
    const nextOptimal  = nextCycleEta ? Math.max(0, nextCycleEta - flightMins + 5) : null;
    return {
      fly: false,
      reason: `stock depletes in ${stockRunway}m, flight=${flightMins}m — gone before landing`,
      nextWindowMins: nextOptimal,
      confidence,
    };
  }

  // ── Stock empty ──────────────────────────────────────────────────────────
  if (!nextRestockEta)
    return { fly: false, reason: "stock empty, no restock ETA", nextWindowMins: null, confidence };

  const landAfterRestock = flightMins - nextRestockEta;

  // Can we land within the stock availability window?
  if (avgStockDuration && landAfterRestock <= avgStockDuration && landAfterRestock >= -10)
    return {
      fly: true,
      reason: `restock in ${nextRestockEta}m, land ${landAfterRestock}m after restock, lasts ${avgStockDuration}m`,
      nextWindowMins: 0,
      confidence,
    };

  // Current restock window missed — calculate next cycle
  if (avgRestockInterval) {
    const nextRestockCycle  = nextRestockEta + avgRestockInterval;
    const nextLandAfter     = flightMins - nextRestockCycle;
    const nextOptimalDepart = nextRestockCycle - flightMins + 5;

    if (avgStockDuration && nextLandAfter <= avgStockDuration && nextLandAfter >= -10) {
      // Can catch next cycle
      if (nextOptimalDepart <= 0) {
        // Depart window is now or already passed — fly immediately
        return {
          fly: true,
          reason: `next cycle in ${nextRestockCycle}m, land ${Math.abs(nextLandAfter)}m after restock, lasts ${avgStockDuration}m — fly now`,
          nextWindowMins: 0,
          confidence,
        };
      }
      return {
        fly: false,
        reason: `restock in ${nextRestockEta}m too soon, next cycle in ${nextRestockCycle}m — depart in ${nextOptimalDepart}m`,
        nextWindowMins: nextOptimalDepart,
        confidence,
      };
    }
  }

  // Fallback — wait for current restock optimal depart
  const optimalDepart = Math.max(0, nextRestockEta - flightMins + 5);
  return {
    fly: false,
    reason: `restock in ${nextRestockEta}m, stock lasts ${avgStockDuration}m — depart in ${optimalDepart}m`,
    nextWindowMins: optimalDepart,
    confidence,
  };
}

// ── Country map ───────────────────────────────────────────────────────────────
const CC = {
  mex: { name: "Mexico",         flight: 18  },
  cay: { name: "Cayman Islands", flight: 25  },
  can: { name: "Canada",         flight: 29  },
  haw: { name: "Hawaii",         flight: 94  },
  uni: { name: "United Kingdom", flight: 111 },
  arg: { name: "Argentina",      flight: 117 },
  swi: { name: "Switzerland",    flight: 123 },
  jap: { name: "Japan",          flight: 158 },
  chi: { name: "China",          flight: 169 },
  uae: { name: "UAE",            flight: 190 },
  sou: { name: "South Africa",   flight: 208 },
};

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const token = req.query.token || req.headers["x-poll-token"];
  if (token !== process.env.POLL_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  const { cc, item } = req.query;
  const buffer = parseInt(req.query.buffer || "0") || 0;
  if (!cc || !CC[cc]) return res.status(400).json({ ok: false, error: `unknown cc: ${cc}` });

  const { name: countryName, flight: flightMins } = CC[cc];

  // Single item
  if (item) {
    const [analysis, latestRaw] = await Promise.all([
      readAnalysis(countryName, item),
      readLatestRaw(countryName, item),
    ]);
    const estimatedRestockMinutes = latestRaw?.estimatedRestockMinutes ?? null;
    if (!analysis) return res.status(200).json({ ok: true, cc, item, countryName, flightMins, fly: null, reason: "no data yet", confidence: 0, estimatedRestockMinutes });
    const prediction = shouldFly(analysis, flightMins, buffer);
    // Use tracker nextRestockEta if available, else fall back to DroqsDB estimatedRestockMinutes
    const restockEta = analysis.nextRestockEta ?? estimatedRestockMinutes;
    return res.status(200).json({ ok: true, cc, item, countryName, flightMins, buffer, ...prediction, estimatedRestockMinutes, restockEta, analysis });
  }

  // Full country
  const all = await readCountryAnalysis(countryName);
  const predictions = {};
  for (const [key, analysis] of Object.entries(all)) {
    const itemName = key.replace(/_/g, " ");
    predictions[itemName] = { ...shouldFly(analysis, flightMins, buffer), currentStock: analysis.currentStock, stockRunway: analysis.stockRunway, nextRestockEta: analysis.nextRestockEta, confidence: analysis.confidence };
  }
  return res.status(200).json({ ok: true, cc, countryName, flightMins, buffer, predictions });
};