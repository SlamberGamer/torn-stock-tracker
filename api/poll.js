const { fetchAllCountries } = require("../lib/droqs");
const { writeRaw, writeAnalysis, readHistory, pruneOldRaw } = require("../lib/firebase");
const { analyze } = require("../lib/depletion");

module.exports = async (req, res) => {
  // ── Token check ──────────────────────────────────────────────────────────
  const token = req.query.token || req.headers["x-poll-token"];
  if (token !== process.env.POLL_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const startTime = Date.now();
  const results   = { ok: true, countries: [], errors: [], ts: startTime };

  try {
    // ── Fetch all countries from DroqsDB ───────────────────────────────────
    const countries = await fetchAllCountries();

    for (const country of countries) {
      const countryResult = { name: country.name, items: 0, errors: 0 };

      for (const item of country.items) {
        try {
          const snapshot = {
            stock:                   item.stock,
            buyPrice:                item.buyPrice,
            marketValue:             item.marketValue,
            bazaarPrice:             item.bazaarPrice,
            profitPerItem:           item.profitPerItem,
            profitPerMinute:         item.profitPerMinute,
            estimatedRestockMinutes: item.estimatedRestockMinutes,
            stockUpdatedAt:          item.stockUpdatedAt,
          };

          // Write raw snapshot
          await writeRaw(country.name, item.itemName, snapshot);

          // Read history and recalculate analysis
          const history  = await readHistory(country.name, item.itemName, 120);
          const analysis = analyze(history);
          await writeAnalysis(country.name, item.itemName, analysis);

          // Prune old data (keep 24h)
          await pruneOldRaw(country.name, item.itemName);

          countryResult.items++;
        } catch (itemErr) {
          countryResult.errors++;
          results.errors.push(`${country.name}/${item.itemName}: ${itemErr.message}`);
        }
      }

      results.countries.push(countryResult);
    }

    results.durationMs = Date.now() - startTime;
    return res.status(200).json(results);

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
