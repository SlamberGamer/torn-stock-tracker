const { readAnalysis, readCountryAnalysis } = require("../lib/firebase");
const { shouldFly, analyze } = require("../lib/depletion");
const { COUNTRIES } = require("../lib/droqs");

// Map cc codes to country names
const CC_TO_NAME = Object.fromEntries(COUNTRIES.map(c => [c.cc, c.name]));
const CC_TO_FLIGHT = Object.fromEntries(COUNTRIES.map(c => [c.cc, c.flightMins]));

module.exports = async (req, res) => {
  // ── Token check ──────────────────────────────────────────────────────────
  const token = req.query.token || req.headers["x-poll-token"];
  if (token !== process.env.POLL_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const { cc, item, flightMins: customFlight } = req.query;

  // ── Single item prediction ─────────────────────────────────────────────
  if (cc && item) {
    const countryName = CC_TO_NAME[cc];
    if (!countryName) {
      return res.status(400).json({ ok: false, error: `unknown cc: ${cc}` });
    }

    const flightMins = customFlight ? parseInt(customFlight) : CC_TO_FLIGHT[cc];
    const analysis   = await readAnalysis(countryName, item);

    if (!analysis) {
      return res.status(200).json({
        ok:         true,
        cc, item, countryName, flightMins,
        fly:        null,
        reason:     "no data yet — still collecting",
        confidence: 0,
      });
    }

    const prediction = shouldFly(analysis, flightMins);

    return res.status(200).json({
      ok: true,
      cc, item, countryName, flightMins,
      ...prediction,
      analysis: {
        currentStock:         analysis.currentStock,
        stockRunway:          analysis.stockRunway,
        depletionRate:        analysis.depletionRate,
        avgStockDuration:     analysis.avgStockDuration,
        avgRestockInterval:   analysis.avgRestockInterval,
        avgStockAfterRestock: analysis.avgStockAfterRestock,
        nextRestockEta:       analysis.nextRestockEta,
        confidence:           analysis.confidence,
        dataPoints:           analysis.dataPoints,
        restockCount:         analysis.restockCount,
      },
    });
  }

  // ── Full country prediction (all items) ───────────────────────────────
  if (cc) {
    const countryName = CC_TO_NAME[cc];
    if (!countryName) {
      return res.status(400).json({ ok: false, error: `unknown cc: ${cc}` });
    }
    const flightMins    = CC_TO_FLIGHT[cc];
    const allAnalysis   = await readCountryAnalysis(countryName);
    const predictions   = {};

    for (const [itemKey, analysis] of Object.entries(allAnalysis)) {
      const itemName       = itemKey.replace(/_/g, " ");
      predictions[itemName] = {
        ...shouldFly(analysis, flightMins),
        currentStock: analysis.currentStock,
        stockRunway:  analysis.stockRunway,
        nextRestockEta: analysis.nextRestockEta,
        confidence:   analysis.confidence,
      };
    }

    return res.status(200).json({
      ok: true,
      cc, countryName, flightMins,
      predictions,
    });
  }

  return res.status(400).json({ ok: false, error: "provide ?cc= and optionally ?item=" });
};
