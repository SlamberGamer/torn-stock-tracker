/**
 * Depletion analysis engine.
 * Takes raw history snapshots and produces:
 *  - depletionRate      : units lost per minute when in stock
 *  - avgStockDuration   : how long stock lasts after restock (minutes)
 *  - avgRestockInterval : minutes between restock events
 *  - avgStockAfterRestock: typical stock level after restock
 *  - nextRestockEta     : predicted minutes until next restock
 *  - confidence         : 0.0 to 1.0
 */

function analyze(history) {
  if (!history || history.length < 3) {
    return { confidence: 0, reason: "insufficient data" };
  }

  // ── Identify restock events ─────────────────────────────────────────────
  // A restock = stock increases significantly between two consecutive readings
  const restockEvents  = [];
  const depletionRuns  = [];
  let   currentRun     = null;

  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    const dt   = (curr.ts - prev.ts) / 60000; // minutes between readings

    // Restock detected: stock jumped up
    if (curr.stock > prev.stock + 10) {
      restockEvents.push({
        ts:          curr.ts,
        stockBefore: prev.stock,
        stockAfter:  curr.stock,
        addedStock:  curr.stock - prev.stock,
      });
      // End previous depletion run
      if (currentRun) {
        currentRun.endTs    = prev.ts;
        currentRun.endStock = prev.stock;
        depletionRuns.push(currentRun);
      }
      // Start new depletion run
      currentRun = { startTs: curr.ts, startStock: curr.stock };
    }

    // Accumulate depletion in current run
    if (currentRun && curr.stock < prev.stock && curr.stock >= 0) {
      if (!currentRun.points) currentRun.points = [];
      currentRun.points.push({ dt, lost: prev.stock - curr.stock });
    }

    // Detect stock hitting 0
    if (currentRun && curr.stock === 0 && prev.stock > 0) {
      currentRun.endTs    = curr.ts;
      currentRun.endStock = 0;
      depletionRuns.push(currentRun);
      currentRun = null;
    }
  }

  // ── Depletion rate ─────────────────────────────────────────────────────
  let depletionRate = null;
  const allRates = [];
  for (const run of depletionRuns) {
    if (!run.points || run.points.length === 0) continue;
    const totalLost = run.points.reduce((s, p) => s + p.lost, 0);
    const totalTime = run.points.reduce((s, p) => s + p.dt, 0);
    if (totalTime > 0) allRates.push(totalLost / totalTime);
  }
  if (allRates.length > 0) {
    depletionRate = allRates.reduce((s, r) => s + r, 0) / allRates.length;
  }

  // ── Stock duration after restock ───────────────────────────────────────
  let avgStockDuration = null;
  const durations = depletionRuns
    .filter(r => r.endTs && r.startTs)
    .map(r => (r.endTs - r.startTs) / 60000);
  if (durations.length > 0) {
    avgStockDuration = durations.reduce((s, d) => s + d, 0) / durations.length;
  }

  // ── Restock interval ───────────────────────────────────────────────────
  let avgRestockInterval = null;
  if (restockEvents.length >= 2) {
    const intervals = [];
    for (let i = 1; i < restockEvents.length; i++) {
      intervals.push((restockEvents[i].ts - restockEvents[i-1].ts) / 60000);
    }
    avgRestockInterval = intervals.reduce((s, i) => s + i, 0) / intervals.length;
  }

  // ── Average stock after restock ────────────────────────────────────────
  let avgStockAfterRestock = null;
  if (restockEvents.length > 0) {
    avgStockAfterRestock = restockEvents.reduce((s, e) => s + e.stockAfter, 0) / restockEvents.length;
  }

  // ── Next restock ETA prediction ────────────────────────────────────────
  let nextRestockEta = null;
  const lastRestock  = restockEvents[restockEvents.length - 1];
  if (lastRestock && avgRestockInterval) {
    const elapsed       = (Date.now() - lastRestock.ts) / 60000;
    const sinceRestock  = elapsed % avgRestockInterval;
    nextRestockEta      = Math.max(0, avgRestockInterval - sinceRestock);
  }

  // ── Current stock runway ───────────────────────────────────────────────
  // How many minutes until current stock runs out
  const latest      = history[history.length - 1];
  let   stockRunway = null;
  if (latest.stock > 0 && depletionRate && depletionRate > 0) {
    stockRunway = latest.stock / depletionRate;
  }

  // ── Confidence ─────────────────────────────────────────────────────────
  let confidence = 0;
  if (history.length >= 10) confidence += 0.2;
  if (history.length >= 30) confidence += 0.2;
  if (restockEvents.length >= 2) confidence += 0.3;
  if (depletionRate !== null) confidence += 0.2;
  if (avgStockDuration !== null) confidence += 0.1;
  confidence = Math.min(1.0, confidence);

  return {
    depletionRate:        depletionRate   ? Math.round(depletionRate * 10) / 10 : null,
    avgStockDuration:     avgStockDuration ? Math.round(avgStockDuration) : null,
    avgRestockInterval:   avgRestockInterval ? Math.round(avgRestockInterval) : null,
    avgStockAfterRestock: avgStockAfterRestock ? Math.round(avgStockAfterRestock) : null,
    nextRestockEta:       nextRestockEta ? Math.round(nextRestockEta) : null,
    stockRunway:          stockRunway ? Math.round(stockRunway) : null,
    currentStock:         latest.stock,
    lastRestock:          lastRestock ? lastRestock.ts : null,
    restockCount:         restockEvents.length,
    dataPoints:           history.length,
    confidence:           Math.round(confidence * 100) / 100,
  };
}

/**
 * Given analysis data and flight time, should we fly NOW?
 * Returns { fly, reason, nextWindowMins }
 */
function shouldFly(analysis, flightMins) {
  if (!analysis || analysis.confidence < 0.3) {
    return {
      fly:            null,
      reason:         "insufficient data — cannot predict",
      nextWindowMins: null,
    };
  }

  const { currentStock, stockRunway, nextRestockEta, avgStockDuration, confidence } = analysis;

  // Stock available now
  if (currentStock > 0) {
    if (stockRunway === null) {
      return { fly: true, reason: "stock available, no depletion data — fly", nextWindowMins: 0 };
    }
    if (stockRunway >= flightMins) {
      return {
        fly:            true,
        reason:         `stock lasts ${stockRunway}m, flight=${flightMins}m — fly now`,
        nextWindowMins: 0,
        confidence,
      };
    } else {
      return {
        fly:            false,
        reason:         `stock depletes in ${stockRunway}m, flight=${flightMins}m — stock gone before landing`,
        nextWindowMins: nextRestockEta,
        confidence,
      };
    }
  }

  // Stock = 0, check next restock
  if (nextRestockEta === null) {
    return { fly: false, reason: "stock empty, no restock ETA", nextWindowMins: null, confidence };
  }

  // Will stock last long enough after restock for us to land and buy?
  // depart now → land in flightMins → need stock to still be there
  const landAfterRestock = flightMins - nextRestockEta; // negative = land before restock

  if (avgStockDuration && landAfterRestock <= avgStockDuration && landAfterRestock >= -10) {
    return {
      fly:            true,
      reason:         `restock in ${nextRestockEta}m, land ${landAfterRestock}m after restock, stock lasts ${avgStockDuration}m — fly now`,
      nextWindowMins: 0,
      confidence,
    };
  }

  // Calculate when to depart for optimal window
  // Want to land ~5min after restock
  const optimalDepart = nextRestockEta - flightMins + 5;

  return {
    fly:            false,
    reason:         `restock in ${nextRestockEta}m, stock lasts ${avgStockDuration}m after restock — wait`,
    nextWindowMins: Math.max(0, optimalDepart),
    confidence,
  };
}

module.exports = { analyze, shouldFly };
