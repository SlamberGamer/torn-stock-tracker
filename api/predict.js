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
  const snap = await getDb().ref(`raw/${san(country)}/${san(itemName)}`).orderByKey().limitToLast(1).once("value");
  const val  = snap.val();
  if (!val) return null;
  const raw = Object.values(val)[0];

  // Recalculate from nextRestockISO if stored estimatedRestockMinutes is null
  if (raw.estimatedRestockMinutes == null && raw.nextRestockISO) {
    const minsUntil = (new Date(raw.nextRestockISO).getTime() - Date.now()) / 60000;
    if (minsUntil > 0 && minsUntil < 1440)
      raw.estimatedRestockMinutes = Math.round(minsUntil);
  }
  return raw;
}

async function readRawHistory(country, itemName, n = 120) {
  const snap = await getDb().ref(`raw/${san(country)}/${san(itemName)}`)
    .orderByKey().limitToLast(n).once("value");
  const val = snap.val();
  if (!val) return [];
  return Object.values(val)
    .map(r => ({ ts: r.ts, stock: r.stock }))
    .sort((a, b) => a.ts - b.ts);
}

// ── shouldFly ─────────────────────────────────────────────────────────────────
function shouldFly(analysis, flightMins, buffer = 0) {
  if (!analysis || analysis.confidence < 0.3)
    return { fly: null, reason: "insufficient data", nextWindowMins: null };

  const { currentStock, stockRunway, avgRestockInterval, confidence } = analysis;
  // Use passed-in nextRestockEta (from predict API combining tracker + raw fallback)
  const nextRestockEta = analysis.nextRestockEta;

  // Apply safety buffer to stock duration
  const rawStockDuration = analysis.avgStockDuration;
  const avgStockDuration = rawStockDuration ? rawStockDuration + buffer : rawStockDuration;
  const bufferStr = buffer !== 0 && rawStockDuration
    ? ` [stock lasts ${rawStockDuration}m, buf ${buffer}m → effective ${avgStockDuration}m]`
    : rawStockDuration ? ` [stock lasts ${rawStockDuration}m]` : "";

  // ── Perpetual stock check ────────────────────────────────────────────────
  // If restocks happen faster than stock depletes → stock always available → always fly
  if (avgRestockInterval && avgStockDuration && avgRestockInterval < avgStockDuration) {
    return {
      fly: true,
      reason: `perpetual stock — restock every ${avgRestockInterval}m, lasts ${avgStockDuration}m${bufferStr}`,
      nextWindowMins: 0,
      confidence,
    };
  }

  // ── Stock available now ──────────────────────────────────────────────────
  if (currentStock > 0) {
    if (!stockRunway)
      return { fly: true, reason: "stock available, no depletion data", nextWindowMins: 0, confidence };
    if (stockRunway >= flightMins)
      return { fly: true, reason: `stock lasts ${stockRunway}m, flight=${flightMins}m`, nextWindowMins: 0, confidence };
    // Stock depletes before landing — check if restock happens mid-flight
    if (nextRestockEta) {
      const landAfterRestock = flightMins - nextRestockEta;
      if (landAfterRestock >= 0 && (!avgStockDuration || landAfterRestock <= avgStockDuration))
        return {
          fly: true,
          reason: `stock gone mid-flight but restock in ${nextRestockEta}m, land ${landAfterRestock}m after restock${bufferStr}`,
          nextWindowMins: 0,
          confidence,
        };
    }
    // Can't catch restock — compute next window
    const nextCycleEta = nextRestockEta || avgRestockInterval;
    const nextOptimal  = nextCycleEta ? Math.max(0, nextCycleEta - flightMins) : null;
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
  if (avgStockDuration && landAfterRestock <= avgStockDuration && landAfterRestock >= 0)
    return {
      fly: true,
      reason: `restock in ${nextRestockEta}m, land ${landAfterRestock}m after restock${bufferStr}`,
      nextWindowMins: 0,
      confidence,
    };

  // Current restock window missed — calculate next cycle
  if (avgRestockInterval) {
    const nextRestockCycle  = nextRestockEta + avgRestockInterval;
    const nextOptimalDepart = nextRestockCycle - flightMins;
    // Actual land offset depends on when we depart:
    // depart now → land at flightMins, restock at nextRestockCycle → offset = flightMins - nextRestockCycle
    // depart at nextOptimalDepart → land exactly at nextRestockCycle → offset = 0
    const actualLandAfter = nextOptimalDepart <= 0
      ? flightMins - nextRestockCycle   // departing now, calc real offset
      : 0;                              // departing at optimal time, land exactly at restock

    if (actualLandAfter >= 0 && (!avgStockDuration || actualLandAfter <= avgStockDuration)) {
      if (nextOptimalDepart <= 0) {
        return {
          fly: true,
          reason: `next cycle in ${nextRestockCycle}m, land ${actualLandAfter}m after restock${bufferStr} — fly now`,
          nextWindowMins: 0,
          confidence,
        };
      }
      return {
        fly: false,
        reason: `restock in ${nextRestockEta}m window missed, next cycle in ${nextRestockCycle}m${bufferStr} — depart in ${nextOptimalDepart}m`,
        nextWindowMins: nextOptimalDepart,
        confidence,
      };
    }
  }

  // Fallback — wait for current restock optimal depart
  const optimalDepart = Math.max(0, nextRestockEta - flightMins);
  return {
    fly: false,
    reason: `restock in ${nextRestockEta}m, stock lasts ${avgStockDuration ?? '?'}m${bufferStr} — ${optimalDepart > 0 ? `depart in ${optimalDepart}m` : 'no viable window this cycle'}`,
    nextWindowMins: optimalDepart || null,
    confidence,
  };
}

async function readRestockHistory(country, itemName) {
  const cutoff = String(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const snap = await getDb().ref(`restockHistory/${san(country)}/${san(itemName)}`)
    .orderByKey().startAt(cutoff).once("value");
  const val = snap.val();
  if (!val) return [];
  return Object.entries(val)
    .map(([k, v]) => ({ ts: parseInt(k), iso: v.iso }))
    .sort((a, b) => a.ts - b.ts);
}

async function readFlightHistory(cc, itemName) {
  const cutoff = String(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const snap = await getDb().ref(`flightHistory/${san(cc)}/${san(itemName)}`)
    .orderByKey().startAt(cutoff).once("value");
  const val = snap.val();
  if (!val) return [];
  return Object.entries(val)
    .map(([k, v]) => ({ ts: parseInt(k), ...v }))
    .sort((a, b) => a.ts - b.ts);
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
    const [analysis, latestRaw, restockHistory, flightHistory, rawHistory] = await Promise.all([
      readAnalysis(countryName, item),
      readLatestRaw(countryName, item),
      readRestockHistory(countryName, item),
      readFlightHistory(cc, item),
      readRawHistory(countryName, item, 720), // last 12h at 1min = 720 pts
    ]);
    const estimatedRestockMinutes = latestRaw?.estimatedRestockMinutes ?? null;
    const buyPrice = latestRaw?.buyPrice ?? null;
    if (!analysis) return res.status(200).json({ ok: true, cc, item, countryName, flightMins, fly: null, reason: "no data yet", confidence: 0, estimatedRestockMinutes, buyPrice, restockHistory: [], flightHistory: [], rawHistory: [] });

    const restockEta = estimatedRestockMinutes ?? analysis.nextRestockEta;
    const mergedAnalysis = Object.assign({}, analysis, { nextRestockEta: restockEta });

    const prediction = shouldFly(mergedAnalysis, flightMins, buffer);
    return res.status(200).json({ ok: true, cc, item, countryName, flightMins, buffer, ...prediction, estimatedRestockMinutes, restockEta, buyPrice, analysis, restockHistory, flightHistory, rawHistory });
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