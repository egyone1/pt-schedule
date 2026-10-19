# PT daily schedule

Every day at 9 PM (Cairo) a GitHub Action reads that day's tab from the customer-service
booking workbook on SharePoint and publishes it as the day's schedule. Each therapist taps a
patient once for **attended** (green), twice for **no-show** (red), and presses **Submit**.
When every therapist has submitted, the day closes and its totals move to the statistics tab.
A session longer than 1 h 15 min counts as two sessions.

- `index.html`, `app.js`, `styles.css`: the site (static, GitHub Pages)
- `store.js`: Firebase Firestore data layer; demo mode (localStorage) when `config.js` has no `apiKey`
- `importer/`: Excel parser + nightly import (`run_import.py`)
- `firestore.rules`: who may write what
- `.github/workflows/import.yml`: the 9 PM job

Phone numbers are never stored. Patient data lives only in Firestore, never in this repo.

## Secrets (repo → Settings → Secrets → Actions)

`SHARE_URL`, `FIREBASE_API_KEY`, `FIREBASE_PROJECT`, `IMPORTER_EMAIL`, `IMPORTER_PASSWORD`

Run the import by hand: Actions → *Nightly schedule import* → Run workflow (optionally a date).
