const admin = require("firebase-admin");

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

// Map Firebase country name → cc code
const NAME_TO_CC = {
  "Mexico":         "mex",
  "Cayman Islands": "cay",
  "Canada":         "can",
  "Hawaii":         "haw",
  "United Kingdom": "uni",
  "Argentina":      "arg",
  "Switzerland":    "swi",
  "Japan":          "jap",
  "China":          "chi",
  "UAE":            "uae",
  "South Africa":   "sou",
};

module.exports = async (req, res) => {
  const token = req.query.token || req.headers["x-poll-token"];
  if (token !== process.env.POLL_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    // Read all analysis entries — keys are country names, values are item maps
    const snap = await getDb().ref("analysis").once("value");
    const val  = snap.val() || {};

    const result = {}; // { cc: [{ name, confidence, currentStock, buyPrice }] }

    for (const [countryKey, items] of Object.entries(val)) {
      // Firebase key uses _ instead of spaces/dots
      const countryName = countryKey.replace(/_/g, " ");
      const cc = NAME_TO_CC[countryName];
      if (!cc) continue;

      result[cc] = [];
      for (const [itemKey, analysis] of Object.entries(items)) {
        if (!analysis || analysis.confidence === 0) continue;
        const itemName = itemKey.replace(/_/g, " ");
        result[cc].push({
          name:         itemName,
          confidence:   analysis.confidence || 0,
          currentStock: analysis.currentStock || 0,
        });
      }

      // Sort by name
      result[cc].sort((a, b) => a.name.localeCompare(b.name));
    }

    return res.status(200).json({ ok: true, items: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
