# torn-stock-tracker

Torn City stock depletion tracker + flight predictor.

Polls DroqsDB every 1 minute for all 11 countries, builds depletion rate history in Firebase, and exposes a `/api/predict` endpoint for v6.py to use before flying.

---

## Setup

### 1. Firebase

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Create new project → name it `torn-stock-tracker`
3. Go to **Realtime Database** → Create database → Start in test mode
4. Go to **Project Settings** → **Service Accounts** → Generate new private key
5. Download the JSON file — you'll need these fields:
   - `project_id`
   - `client_email`
   - `private_key`
   - Database URL: `https://torn-stock-tracker-default-rtdb.firebaseio.com`

### 2. Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel --prod
```

### 3. Set Environment Variables in Vercel

Go to Vercel dashboard → your project → Settings → Environment Variables:

```
FIREBASE_PROJECT_ID      = torn-stock-tracker
FIREBASE_CLIENT_EMAIL    = firebase-adminsdk-xxxxx@torn-stock-tracker.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY     = -----BEGIN PRIVATE KEY-----\n...
FIREBASE_DATABASE_URL    = https://torn-stock-tracker-default-rtdb.firebaseio.com
POLL_TOKEN               = your_secret_token_here
```

### 4. Set up cron-job.org

1. Go to [cron-job.org](https://cron-job.org)
2. Create account → New cronjob
3. URL: `https://torn-stock-tracker.vercel.app/api/poll?token=your_secret_token_here`
4. Schedule: Every 1 minute
5. Enable → Save

---

## API Endpoints

### Poll (called by cron-job.org)
```
GET /api/poll?token=YOUR_TOKEN
```

### Predict — single item
```
GET /api/predict?token=YOUR_TOKEN&cc=jap&item=Xanax
```

Response:
```json
{
  "ok": true,
  "cc": "jap",
  "item": "Xanax",
  "countryName": "Japan",
  "flightMins": 158,
  "fly": false,
  "reason": "stock depletes in 12m, flight=158m — stock gone before landing",
  "nextWindowMins": 34,
  "confidence": 0.85,
  "analysis": {
    "currentStock": 312,
    "stockRunway": 12,
    "depletionRate": 26,
    "avgStockDuration": 22,
    "avgRestockInterval": 38,
    "avgStockAfterRestock": 750,
    "nextRestockEta": 34,
    "dataPoints": 87,
    "restockCount": 3
  }
}
```

### Predict — full country
```
GET /api/predict?token=YOUR_TOKEN&cc=jap
```

---

## v6.py Integration

Replace `_check_priority_viable()` call with:
```python
PREDICT_URL = "https://torn-stock-tracker.vercel.app/api/predict"
POLL_TOKEN  = "your_secret_token_here"

r = requests.get(PREDICT_URL, params={"token": POLL_TOKEN, "cc": cc, "item": item_name}, timeout=5)
data = r.json()
fly = data.get("fly")        # True/False/None
reason = data.get("reason")
next_window = data.get("nextWindowMins")
```

---

## Notes

- Raw data is pruned after 24 hours automatically
- Confidence score rises with more data points and observed restock events
- Minimum ~30 minutes of data before useful predictions
- Full accuracy after ~3 restock cycles observed (~2-3 hours for fast items)
