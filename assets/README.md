# PSP Lead Capture — Setup & Deployment Guide

A mobile-first, offline-first PWA for **Parth Sarathi Partners** to capture leads at JITO Jobs Mela 2026. Designed for Srishti & Riddhi to use in the field on Android / iPhone browsers, with full offline support and automatic sync to Google Sheets.

---

## 1. What's in this folder

```
Data Capturing/
├── index.html                  ← Main app entry
├── styles.css                  ← Full UI styling
├── app.js                      ← All application logic
├── manifest.json               ← PWA manifest (icons + theme)
├── sw.js                       ← Service Worker (offline cache)
├── assets/
│   ├── logo.png                ← PSP brand mark
│   ├── team.jpg                ← Srishti & Riddhi photo (DROP THIS IN)
│   ├── recruitment.pdf         ← Recruitment company profile
│   ├── consulting.pdf          ← Consulting / Company Introduction
│   ├── icon-192.png            ← PWA icons (auto-generated)
│   ├── icon-512.png
│   ├── icon-180.png            ← iOS home-screen icon
│   └── icon-maskable-512.png
├── apps-script/
│   └── Code.gs                 ← Google Apps Script (paste into Sheet)
└── README.md                   ← This file
```

### Important — add the team photo

The combined photo of Srishti & Riddhi must be saved as **`assets/team.jpg`** inside this folder. Once you copy it in, the WhatsApp flow will pick it up automatically. If you don't see the photo card during a WhatsApp send, this file is missing or named incorrectly.

---

## 2. Deployment

The app is a static set of files. You have three options, in order of preference:

### Option A — GitHub Pages (recommended, free, takes 5 minutes)

1. Go to `https://github.com/new` and create a new repo named `psp-leads`.
2. Upload **all files in this folder** (drag & drop in the web UI works).
3. In repo → `Settings` → `Pages` → set source = `main` branch, root folder.
4. Wait ~1 minute. GitHub will give you a URL like `https://YOUR-USER.github.io/psp-leads/`.
5. Open that URL on your phone — that's the app.

### Option B — Netlify Drop (drag-and-drop, also free)

1. Visit `https://app.netlify.com/drop`
2. Drag the entire `Data Capturing` folder into the browser.
3. Netlify gives you a URL instantly.

### Option C — Local network (for testing / offline-only deployment)

Run from a phone/laptop using any tiny static server:

```bash
# In the Data Capturing folder
python3 -m http.server 8080
# then visit http://<your-ip>:8080 on the phone (must be on same Wi-Fi)
```

> **HTTPS is required for the camera + PWA install.** GitHub Pages and Netlify both serve HTTPS by default. For local testing, use Chrome's `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and add your `http://...` URL.

---

## 3. Install as a PWA on the phone

Once the app is loaded once over the network, it works offline forever after.

### Android (Chrome)
1. Open the deployed URL in Chrome.
2. You'll see an "Install" banner at the bottom — tap it.
3. Or: tap ⋮ menu → "Add to Home screen" → Install.
4. The PSP logo appears on your home screen. Tap to launch — fullscreen, no browser bar.

### iPhone (Safari) — Safari only, not Chrome
1. Open the deployed URL in **Safari**.
2. Tap the Share button (square with up-arrow).
3. Scroll down → tap "Add to Home Screen".
4. Tap "Add". The icon appears on your home screen.

---

## 4. Google Sheets setup

### 4.1 Prepare the Sheet
Your Sheet is here:
`https://docs.google.com/spreadsheets/d/1YVPsaGP-ZukYy8t9MZHlDmG7qEJcMhFwbI2MfS4aVTQ/edit`

The Apps Script will auto-create a tab named **`Entries`** and populate headers on first sync — you don't need to do anything to the sheet itself.

### 4.2 Install the Apps Script
1. Open your Sheet → menu **Extensions → Apps Script**.
2. Delete any code in the editor.
3. Open `apps-script/Code.gs` from this folder, copy the entire contents, paste into the Apps Script editor.
4. Click the 💾 Save icon (give the project a name like "PSP Leads Bridge").
5. Click **Deploy → New deployment**.
6. Click the gear ⚙ next to "Select type" → choose **Web app**.
7. Set:
   - **Description**: `PSP Leads v1`
   - **Execute as**: `Me`
   - **Who has access**: **Anyone** (this lets the PWA POST without OAuth)
8. Click **Deploy**.
9. Authorize when prompted (Google → Advanced → Go to project → Allow).
10. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/AKfy.../exec`).

### 4.3 Paste the URL into the app
1. Open the PWA on your phone.
2. Tap **Settings** (bottom nav).
3. Paste the URL into "Apps Script Web App URL".
4. Tap **Test connection** — you should see a green "Apps Script reachable" toast.

That's it. Every saved entry now auto-syncs to your Sheet. Offline entries queue up and sync when internet reconnects.

---

## 5. How offline works

| Scenario | What happens |
| --- | --- |
| Browser closes mid-entry | Form is gone, but anything already saved (tap "Add Entry") is in IndexedDB. |
| Add entries with no internet | Entries save locally instantly. A "Pending" pill appears in the header. |
| Internet reconnects | Background sync flushes the queue automatically. Pill goes green. |
| Phone restarts | Data is preserved — IndexedDB is persistent. App icon launches fullscreen. |
| Tab refresh | Service Worker serves cached app shell instantly; data still there. |
| App reload after weeks offline | Still works. Backup at least weekly via Settings → Export Excel. |

Storage size: ~1–2 KB per entry text + ~150 KB per card image (downscaled). 1000 entries with images ≈ 150 MB. Plenty of headroom.

---

## 6. Field operating tips

- **Open the app once with internet before the event** so the Service Worker caches Tesseract.js (the OCR engine, ~10 MB). After that, OCR works fully offline.
- Pin the app to home screen as a PWA — it launches instantly, no Safari/Chrome chrome.
- **Use rear camera** when capturing cards. The app forces `capture="environment"`.
- After each lead: tap **WhatsApp** → the message is pre-typed; just send. PDFs need 2 taps to attach (see WhatsApp limitation below).
- At the end of the day: **Settings → Export Excel** as a safety net (in addition to the live Sheet).

---

## 7. WhatsApp attachment limitation (read this)

**Browsers cannot programmatically attach files to a WhatsApp chat.** This is a WhatsApp/OS sandbox restriction — every web app hits this wall, not just ours.

The app handles it with the cleanest possible workaround:

1. Tap **WhatsApp** on an entry.
2. **Android**: the native share sheet pops up with the PDFs and team photo pre-selected → pick WhatsApp → done (1 tap).
3. **iPhone / older Android**: WhatsApp opens with the message pre-typed; a helper sheet shows the relevant attachments. Tap each to download, then in WhatsApp tap 📎 → Document/Photo → pick from your Files/Photos. ~3 taps per file.

The message body is also copied to the clipboard as a backup.

---

## 8. Manual data backup

In **Settings**:
- **Excel** — full .xlsx file with all entries and statuses
- **CSV** — opens in any spreadsheet program
- **JSON** — full structured dump (excludes card images for size)

Recommended cadence at events: export to Excel at the end of every break or every 50 entries.

---

## 9. Troubleshooting

| Problem | Fix |
| --- | --- |
| "OCR engine still loading" | Connect to internet once for ~30 seconds. Tesseract caches after first load. |
| Camera button does nothing | iOS Safari requires HTTPS. Use the GitHub Pages / Netlify URL, not raw HTML. |
| Apps Script says "Authorization required" | Re-run step 4.2 step 9 (the Authorize flow). |
| Pending count keeps growing | Open Settings → Test connection. Check the script URL is exact, including `/exec`. |
| WhatsApp opens to a blank chat | The number didn't parse to E.164. Edit the entry's mobile field and retry. |
| App icon shows wrong image | Hard-refresh the page once (Ctrl+Shift+R on desktop, or remove and re-add to home screen on phone). |

---

## 10. Customizing

- **Event name & date**: Settings tab in the app.
- **WhatsApp message wording**: edit `WA.buildMessage()` in `app.js`.
- **Branding colors**: edit the `:root` block in `styles.css`.
- **Sheet columns**: edit `HEADERS` in `apps-script/Code.gs` (keep the order — `app.js` writes them in this order).

---

## 11. Privacy

- All data lives in **your** Google Sheet and on **your** phones.
- The OCR runs entirely on-device (Tesseract.js). Card images never leave the phone unless you choose to include them in an export.
- The Apps Script Web App is set to "Anyone" so the PWA can POST to it — but only those with the exact URL can write, and the script only accepts the JSON shape it expects.

---

**Built for Parth Sarathi Partners · v1.0.0**
