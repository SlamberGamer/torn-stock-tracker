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

function san(str) { return str.replace(/[.#$[\]/\s]/g, "_"); }

// POST /api/log
// Body: { type, cc, item, ts, result, qty }
// type: "depart" | "arrive"
// result: "bought" | "empty" (for arrive only)
// qty: number bought (for arrive+bought only)

module.exports = async (req, res) => {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  const token = req.query.token || req.headers["x-poll-token"] || req.body?.token;
  if (token !== process.env.POLL_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  const { type, cc, item, result, qty } = req.body || {};
  const ts = req.body?.ts || Date.now();

  if (!type || !cc || !item)
    return res.status(400).json({ ok: false, error: "missing type/cc/item" });

  if (!["depart", "arrive"].includes(type))
    return res.status(400).json({ ok: false, error: "type must be depart or arrive" });

  const entry = { type, ts };
  if (type === "arrive") {
    entry.result = result || "empty";
    if (result === "bought" && qty) entry.qty = qty;
  }

  const key = String(ts);
  await getDb()
    .ref(`flightHistory/${san(cc)}/${san(item)}/${key}`)
    .set(entry);

  return res.status(200).json({ ok: true, logged: entry });
};
