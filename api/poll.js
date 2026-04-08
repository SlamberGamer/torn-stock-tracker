const admin = require("firebase-admin");
const fetch = require("node-fetch");

// ── Firebase ──────────────────────────────────────────────────────────────────
let _app = null;
function getDb() {
  if (!_app) {
    _app = admin.initializeApp({
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

async function writeRaw(country, itemName, data) {
  await getDb().ref(`raw/${san(country)}/${san(itemName)}/${Date.now()}`).set(data);
}

async function writeAnalysis(country, itemName, analysis) {
  await getDb().ref(`analysis/${san(country)}/${san(itemName)}`).set({ ...analysis, updatedAt: Date.now() });
}

async function readHistory(country, itemName, n = 120) {
  const snap = await getDb().ref(`raw/${san(country)}/${san(itemName)}`).orderByKey().limitToLast(n).once("value");
  const val  = snap.val();
  return val ? Object.values(val).sort((a, b) => a.ts - b.ts) : [];
}

async function pruneOld(country, itemName) {
  const cutoff = String(Date.now() - 24 * 60 * 60 * 1000);
  const snap   = await getDb().ref(`raw/${san(country)}/${san(itemName)}`).orderByKey().endAt(cutoff).limitToLast(100).once("value");
  const val    = snap.val();
  if (!val) return;
  const upd = {};
  Object.keys(val).forEach(k => upd[k] = null);
  await getDb().ref(`raw/${san(country)}/${san(itemName)}`).update(upd);
}

// ── Restock history from Prometheus datetimes ─────────────────────────────────
// Saves every unique nextRestock datetime seen — key = epoch ms of that datetime
// This builds our own accurate restock timeline independent of stock qty polling

async function saveRestockDatetime(country, itemName, nextRestockISO) {
  const restockTs = new Date(nextRestockISO).getTime();
  if (isNaN(restockTs)) return;
  // Only save future-ish restocks (not already >7 days past)
  if (restockTs < Date.now() - 7 * 24 * 60 * 60 * 1000) return;
  const key = String(restockTs);
  const ref = getDb().ref(`restockHistory/${san(country)}/${san(itemName)}/${key}`);
  const existing = await ref.once("value");
  if (!existing.val()) {
    await ref.set({ iso: nextRestockISO, savedAt: Date.now() });
  }
}

async function readRestockHistory(country, itemName) {
  // Keep last 30 days of restock history
  const cutoff = String(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const snap = await getDb().ref(`restockHistory/${san(country)}/${san(itemName)}`)
    .orderByKey().startAt(cutoff).once("value");
  const val = snap.val();
  if (!val) return [];
  return Object.entries(val)
    .map(([k, v]) => ({ ts: parseInt(k), iso: v.iso }))
    .sort((a, b) => a.ts - b.ts);
}

function analyzeRestockHistory(history) {
  // history = [{ts, iso}] sorted ascending by ts
  if (!history || history.length < 2) return { promInterval: null, promNextEta: null, promRestockCount: history ? history.length : 0 };

  const now = Date.now();

  // Calculate intervals between consecutive restock datetimes
  const intervals = [];
  for (let i = 1; i < history.length; i++) {
    const diff = (history[i].ts - history[i - 1].ts) / 60000;
    // Sanity check: intervals should be between 30min and 8h
    if (diff >= 30 && diff <= 480) intervals.push(diff);
  }
  if (!intervals.length) return { promInterval: null, promNextEta: null, promRestockCount: history.length };

  const promInterval = Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length);

  // Find the most recent restock that has already passed
  const past = history.filter(h => h.ts < now);
  let promNextEta = null;
  if (past.length) {
    const lastPast = past[past.length - 1];
    const elapsed  = (now - lastPast.ts) / 60000;
    const eta      = promInterval - (elapsed % promInterval);
    promNextEta    = Math.round(Math.max(0, eta));
  } else {
    // All restocks are in the future — nearest one
    const future = history.filter(h => h.ts > now);
    if (future.length) promNextEta = Math.round((future[0].ts - now) / 60000);
  }

  return { promInterval, promNextEta, promRestockCount: history.length };
}

// ── Depletion analysis ────────────────────────────────────────────────────────
function analyze(history) {
  if (!history || history.length < 3) return { confidence: 0, dataPoints: history ? history.length : 0 };

  const restockEvents = [];
  const depletionRuns = [];
  let currentRun = null;

  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];

    if (curr.stock > prev.stock + 10) {
      restockEvents.push({ ts: curr.ts, stockAfter: curr.stock });
      if (currentRun) { currentRun.endTs = prev.ts; depletionRuns.push(currentRun); }
      currentRun = { startTs: curr.ts, startStock: curr.stock, points: [] };
    }
    if (currentRun && curr.stock < prev.stock) {
      currentRun.points.push({ dt: (curr.ts - prev.ts) / 60000, lost: prev.stock - curr.stock });
    }
    if (currentRun && curr.stock === 0 && prev.stock > 0) {
      currentRun.endTs = curr.ts;
      depletionRuns.push(currentRun);
      currentRun = null;
    }
  }

  const rates = depletionRuns.filter(r => r.points && r.points.length > 0).map(r => {
    const lost = r.points.reduce((s, p) => s + p.lost, 0);
    const time = r.points.reduce((s, p) => s + p.dt, 0);
    return time > 0 ? lost / time : null;
  }).filter(Boolean);
  const depletionRate = rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : null;

  const durations = depletionRuns.filter(r => r.endTs && r.startTs).map(r => (r.endTs - r.startTs) / 60000);
  const avgStockDuration = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null;

  let avgRestockInterval = null;
  if (restockEvents.length >= 2) {
    const intervals = [];
    for (let i = 1; i < restockEvents.length; i++)
      intervals.push((restockEvents[i].ts - restockEvents[i - 1].ts) / 60000);
    avgRestockInterval = intervals.reduce((s, i) => s + i, 0) / intervals.length;
  }

  const avgStockAfterRestock = restockEvents.length
    ? restockEvents.reduce((s, e) => s + e.stockAfter, 0) / restockEvents.length : null;

  let nextRestockEta = null;
  const lastRestock = restockEvents[restockEvents.length - 1];
  if (lastRestock && avgRestockInterval) {
    const elapsed = (Date.now() - lastRestock.ts) / 60000;
    nextRestockEta = Math.max(0, avgRestockInterval - (elapsed % avgRestockInterval));
  }

  const latest = history[history.length - 1];
  const stockRunway = latest.stock > 0 && depletionRate ? latest.stock / depletionRate : null;

  let confidence = 0;
  if (history.length >= 10) confidence += 0.2;
  if (history.length >= 30) confidence += 0.2;
  if (restockEvents.length >= 2) confidence += 0.2;
  if (depletionRate !== null) confidence += 0.2;
  if (avgStockDuration !== null) confidence += 0.1;
  // promRestockCount added later from restockHistory merge

  // ── Hourly depletion buckets (TCT = UTC hour) ──────────────────────────────
  // Group depletion points by UTC hour, compute avg rate + duration per bucket
  const hourlyRates    = {}; // { "H": [rate, rate, ...] }
  const hourlyDurs     = {}; // { "H": [duration, ...] }

  depletionRuns.forEach(run => {
    if (!run.points || !run.points.length) return;
    // Use startTs hour as the bucket key
    const h = String(new Date(run.startTs).getUTCHours());
    const lost = run.points.reduce((s, p) => s + p.lost, 0);
    const time = run.points.reduce((s, p) => s + p.dt, 0);
    if (time > 0 && lost > 0) {
      if (!hourlyRates[h]) hourlyRates[h] = [];
      hourlyRates[h].push(lost / time);
    }
    if (run.endTs && run.startTs) {
      if (!hourlyDurs[h]) hourlyDurs[h] = [];
      hourlyDurs[h].push((run.endTs - run.startTs) / 60000);
    }
  });

  // Compute averages — require min 2 data points per bucket
  const hourlyDepletionRate  = {};
  const hourlyStockDuration  = {};
  for (let h = 0; h < 24; h++) {
    const key = String(h);
    const rArr = hourlyRates[key] || [];
    const dArr = hourlyDurs[key]  || [];
    hourlyDepletionRate[key] = rArr.length >= 2
      ? +( rArr.reduce((s,v) => s+v, 0) / rArr.length ).toFixed(1)
      : null;
    hourlyStockDuration[key] = dArr.length >= 2
      ? Math.round( dArr.reduce((s,v) => s+v, 0) / dArr.length )
      : null;
  }

  return {
    depletionRate: depletionRate ? +depletionRate.toFixed(1) : null,
    avgStockDuration: avgStockDuration ? Math.round(avgStockDuration) : null,
    avgRestockInterval: avgRestockInterval ? Math.round(avgRestockInterval) : null,
    avgStockAfterRestock: avgStockAfterRestock ? Math.round(avgStockAfterRestock) : null,
    nextRestockEta: nextRestockEta ? Math.round(nextRestockEta) : null,
    stockRunway: stockRunway ? Math.round(stockRunway) : null,
    currentStock: latest.stock,
    restockCount: restockEvents.length,
    dataPoints: history.length,
    confidence: +Math.min(1, confidence).toFixed(2),
    hourlyDepletionRate,
    hourlyStockDuration,
  };
}

// ── Prometheus cc → country name map ─────────────────────────────────────────
const CC_TO_NAME = {
  mex: "Mexico",
  cay: "Cayman Islands",
  can: "Canada",
  haw: "Hawaii",
  uni: "United Kingdom",
  arg: "Argentina",
  swi: "Switzerland",
  jap: "Japan",
  chi: "China",
  uae: "UAE",
  sou: "South Africa",
};

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const token = req.query.token || req.headers["x-poll-token"];
  if (token !== process.env.POLL_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  const start  = Date.now();
  const errors = [];

  // ── Fetch all countries from Prometheus in ONE call ───────────────────────
  let prometheusData;
  try {
    const resp = await fetch("https://prombot.co.uk:8443/api/travel", { timeout: 15000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    prometheusData = await resp.json();
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Prometheus fetch failed: ${e.message}` });
  }

  const stocks    = prometheusData.stocks || {};
  const serverTs  = (prometheusData.timestamp || Date.now() / 1000) * 1000; // ms
  const now       = Date.now();

  // ── Process each country in parallel ─────────────────────────────────────
  const results = await Promise.all(
    Object.entries(CC_TO_NAME).map(async ([cc, countryName]) => {
      const countryData = stocks[cc];
      if (!countryData) {
        errors.push(`${countryName}: not in Prometheus response`);
        return { country: countryName, items: 0 };
      }

      let itemCount = 0;
      await Promise.all((countryData.stocks || []).map(async (item) => {
        try {
          // Calculate estimatedRestockMinutes from nextRestock datetime
          let estimatedRestockMinutes = null;
          if (item.nextRestock) {
            const restockTs = new Date(item.nextRestock).getTime();
            const minsUntil = (restockTs - now) / 60000;
            // Only use if in the future and within 24h
            if (minsUntil > 0 && minsUntil < 1440) {
              estimatedRestockMinutes = Math.round(minsUntil);
            }
          }

          const snap = {
            ts:                      now,
            stock:                   item.quantity,
            buyPrice:                item.cost,
            estimatedRestockMinutes,
            nextRestockISO:          item.nextRestock || null,
            prometheusUpdated:       countryData.update || null,
          };

          await writeRaw(countryName, item.name, snap);

          // Save nextRestock datetime to our own history (deduplicated)
          if (item.nextRestock) {
            await saveRestockDatetime(countryName, item.name, item.nextRestock);
          }

          const [history, restockHistory] = await Promise.all([
            readHistory(countryName, item.name, 120),
            readRestockHistory(countryName, item.name),
          ]);

          const analysis        = analyze(history);
          const restockAnalysis = analyzeRestockHistory(restockHistory);

          // ── Interval blend: Prometheus datetime vs qty-jump detection ─────────
          // When they agree (diff < 10m) → trust Prometheus (more precise timing)
          // When they disagree (diff >= 10m) → trust qty-based (ground truth of what arrived)
          // For nextRestockEta: always use Prometheus datetime directly (strongest single-ETA signal)
          const promInterval = restockAnalysis.promInterval;
          const qtyInterval  = analysis.avgRestockInterval;
          let blendedInterval = null;
          let intervalSource  = 'none';

          if (promInterval && qtyInterval) {
            const diff = Math.abs(promInterval - qtyInterval);
            if (diff < 10) {
              blendedInterval = promInterval;   // agree → Prometheus wins (precise)
              intervalSource  = 'prom';
            } else {
              blendedInterval = qtyInterval;    // disagree → qty-jump wins (ground truth)
              intervalSource  = 'qty';
            }
          } else if (promInterval) {
            blendedInterval = promInterval;
            intervalSource  = 'prom';
          } else if (qtyInterval) {
            blendedInterval = qtyInterval;
            intervalSource  = 'qty';
          }

          const promBoost = restockAnalysis.promRestockCount >= 5 ? 0.3 :
                            restockAnalysis.promRestockCount >= 2 ? 0.2 : 0;
          const mergedAnalysis = Object.assign({}, analysis, {
            avgRestockInterval: blendedInterval,
            nextRestockEta:     restockAnalysis.promNextEta || analysis.nextRestockEta,
            promRestockCount:   restockAnalysis.promRestockCount,
            intervalSource,
            promInterval,
            qtyInterval,
            confidence:         +Math.min(1, analysis.confidence + promBoost).toFixed(2),
          });

          await writeAnalysis(countryName, item.name, mergedAnalysis);
          await pruneOld(countryName, item.name);
          itemCount++;
        } catch (e) {
          errors.push(`${countryName}/${item.name}: ${e.message}`);
        }
      }));

      return { country: countryName, items: itemCount };
    })
  );

  return res.status(200).json({
    ok: true,
    source: "prometheus",
    countries: results,
    errors,
    durationMs: Date.now() - start,
  });
};