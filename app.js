/* =====================================================================
   PSP Lead Capture — Application logic
   ---------------------------------------------------------------------
   Modules:
     • DB      : IndexedDB wrapper (persistent storage)
     • Storage : Settings (localStorage)
     • OCR     : Tesseract.js + business-card parser
     • Sync    : Google Apps Script POST queue with retry
     • UI      : Views, lists, dashboard, modals, toast
     • WA      : WhatsApp deep-link + attachment helper
     • Contact : vCard generation
     • Export  : Excel / CSV / JSON downloads
   =====================================================================*/

'use strict';

/* ========================================================================
   1. CONSTANTS & SETTINGS
   ======================================================================== */
const APP = {
  version: '1.0.0',
  dbName: 'psp-leads',
  dbVersion: 2,
  store: 'entries',
  syncStore: 'sync_queue',
  defaultEvent: 'JITO Jobs Mela',
  defaultEventDate: '23rd May 2026',
  signOff: 'Srishti Shah & Riddhi Sheth',
  signOffEmail: 'info@parthsarathipartners.com',
  attachments: {
    recruitment: 'assets/recruitment.pdf',
    consulting: 'assets/consulting.pdf',
    team: 'assets/team.jpg'
  }
};

const SettingsKey = {
  scriptUrl: 'psp.scriptUrl',
  event: 'psp.event',
  eventDate: 'psp.eventDate'
};

const Settings = {
  get(key, fallback = '') {
    try { return localStorage.getItem(key) || fallback; }
    catch (e) { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }
};

/* ========================================================================
   2. INDEXED DB WRAPPER
   ======================================================================== */
const DB = (() => {
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(APP.dbName, APP.dbVersion);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(APP.store)) {
          const s = db.createObjectStore(APP.store, { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt', { unique: false });
          s.createIndex('synced', 'synced', { unique: false });
        }
        if (!db.objectStoreNames.contains(APP.syncStore)) {
          db.createObjectStore(APP.syncStore, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function put(entry) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(APP.store, 'readwrite');
      tx.objectStore(APP.store).put(entry);
      tx.oncomplete = () => resolve(entry);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(APP.store, 'readonly');
      const req = tx.objectStore(APP.store).getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        // Newest first
        all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(all);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function get(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(APP.store, 'readonly');
      const req = tx.objectStore(APP.store).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(APP.store, 'readwrite');
      tx.objectStore(APP.store).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([APP.store, APP.syncStore], 'readwrite');
      tx.objectStore(APP.store).clear();
      tx.objectStore(APP.syncStore).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // Sync queue
  async function queueAdd(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(APP.syncStore, 'readwrite');
      tx.objectStore(APP.syncStore).put({ id, queuedAt: Date.now(), attempts: 0 });
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  }
  async function queueRemove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(APP.syncStore, 'readwrite');
      tx.objectStore(APP.syncStore).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  }
  async function queueAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(APP.syncStore, 'readonly');
      const req = tx.objectStore(APP.syncStore).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  return { open, put, getAll, get, remove, clearAll, queueAdd, queueRemove, queueAll };
})();

/* ========================================================================
   3. UTILITIES
   ======================================================================== */
const Utils = {
  uid() {
    return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  },

  toast(message, type = '') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast' + (type ? ' toast-' + type : '');
    setTimeout(() => el.classList.add('hidden'), 3200);
  },

  /** Read a File/Blob as DataURL with optional downscale. */
  async readImageAsDataURL(file, maxDim = 1600, quality = 0.82) {
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    // Downscale to keep IndexedDB lean and OCR fast
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  },

  formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString('en-IN', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  },

  isToday(ts) {
    if (!ts) return false;
    const d = new Date(ts), n = new Date();
    return d.getFullYear() === n.getFullYear()
      && d.getMonth() === n.getMonth()
      && d.getDate() === n.getDate();
  },

  /** WhatsApp-friendly phone (digits only, no +/spaces). */
  normalizePhone(raw) {
    if (!raw) return '';
    let p = raw.replace(/[^\d+]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (p.length === 10) p = '91' + p;       // assume India if 10 digits
    if (p.startsWith('0') && p.length === 11) p = '91' + p.slice(1);
    return p;
  },

  escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  },

  download(filename, content, mime = 'application/octet-stream') {
    const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
  },

  dataUrlToBlob(dataUrl) {
    const [meta, b64] = dataUrl.split(',');
    const mime = meta.match(/:(.*?);/)[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
};

/* ========================================================================
   4. OCR — Tesseract.js + business card parser
   ======================================================================== */
const OCR = (() => {
  let _worker = null;

  function setProgress(pct, status) {
    const fill = document.getElementById('ocrFill');
    const s = document.getElementById('ocrStatus');
    if (fill) fill.style.width = Math.round(pct * 100) + '%';
    if (s && status) s.textContent = status;
  }

  async function getWorker() {
    if (_worker) return _worker;
    if (!window.Tesseract) throw new Error('OCR engine not loaded — check internet on first launch.');
    _worker = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          setProgress(m.progress, `Reading card · ${Math.round(m.progress * 100)}%`);
        }
      }
    });
    return _worker;
  }

  /** Run OCR on an array of dataURLs; returns combined raw text + parsed object. */
  async function extract(dataUrls) {
    const wrap = document.getElementById('ocrProgress');
    wrap.classList.remove('hidden');
    setProgress(0, 'Loading OCR engine…');
    try {
      const worker = await getWorker();
      let fullText = '';
      for (let i = 0; i < dataUrls.length; i++) {
        setProgress(0, `Reading side ${i + 1} of ${dataUrls.length}…`);
        const { data } = await worker.recognize(dataUrls[i]);
        fullText += '\n' + (data.text || '');
      }
      setProgress(1, 'Parsing fields…');
      const parsed = parse(fullText);
      setTimeout(() => wrap.classList.add('hidden'), 800);
      return { rawText: fullText, parsed };
    } catch (e) {
      wrap.classList.add('hidden');
      throw e;
    }
  }

  /** Heuristic business-card parser. */
  function parse(raw) {
    const text = (raw || '').replace(/[\t]+/g, ' ');
    const lines = text.split('\n')
      .map(l => l.replace(/[​-‍﻿]/g, '').trim())
      .filter(Boolean);

    // ---- Email ----
    const emailMatch = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
    const email = emailMatch ? emailMatch[0].replace(/[,;]$/, '') : '';

    // ---- Phone (India-tolerant) ----
    const phoneMatches = text.match(/(?:\+?91[\s\-]?)?[\(\s]?\d[\d\s\-\(\)]{8,15}\d/g) || [];
    let mobile = '';
    for (const p of phoneMatches) {
      const digits = p.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 13) { mobile = p.trim(); break; }
    }

    // ---- Address heuristic ----
    const addrKeywords = /\b(road|street|st\.|lane|marg|nagar|colony|sector|block|building|floor|tower|near|opp\.?|opposite|pin|pincode|mumbai|delhi|bengaluru|bangalore|chennai|kolkata|hyderabad|pune|ahmedabad|surat|jaipur|india|gujarat|maharashtra|karnataka|tamil nadu|west bengal|andhra|telangana|kerala|punjab|haryana|rajasthan|madhya pradesh|odisha|bihar)\b/i;
    const pinRegex = /\b\d{6}\b/;
    let addrLines = [];
    for (const l of lines) {
      if (addrKeywords.test(l) || pinRegex.test(l)) addrLines.push(l);
    }
    const address = addrLines.join(', ');

    // ---- Designation / position heuristic ----
    const titleKeywords = /\b(ceo|cto|cfo|coo|cmo|founder|co\-?founder|director|managing\s*director|md|partner|principal|head|chief|vp|vice\s*president|president|manager|senior\s*manager|asst\.?\s*manager|associate|consultant|advisor|analyst|engineer|developer|designer|lead|architect|specialist|officer|executive|administrator|coordinator|recruiter|hr|talent|strategy|operations)\b/i;
    let position = '';
    for (const l of lines) {
      if (titleKeywords.test(l) && l.length < 80) { position = l; break; }
    }

    // ---- Company heuristic ----
    const companyKeywords = /\b(pvt\.?\s*ltd|private\s+limited|ltd\.?|limited|llp|inc\.?|incorporated|corp\.?|corporation|company|co\.?|associates|partners|solutions|services|technologies|technology|tech|systems|consulting|consultants|enterprises|industries|group|ventures|advisors|labs)\b/i;
    let company = '';
    for (const l of lines) {
      if (companyKeywords.test(l) && l.length < 90) { company = l; break; }
    }

    // ---- Name heuristic ----
    // Prefer the first line that:
    //   - is not the email/phone/address/company/position
    //   - is 2-4 words, starts with capital letter
    let name = '';
    const wordCountOK = (l) => {
      const w = l.split(/\s+/).filter(Boolean);
      return w.length >= 1 && w.length <= 5;
    };
    const looksLikeName = (l) => {
      if (!l) return false;
      if (/[@\d]/.test(l)) return false;
      if (titleKeywords.test(l)) return false;
      if (companyKeywords.test(l)) return false;
      if (addrKeywords.test(l)) return false;
      if (/^(www\.|https?)/i.test(l)) return false;
      if (!wordCountOK(l)) return false;
      const caps = l.split(/\s+/).filter(w => /^[A-Z]/.test(w)).length;
      return caps >= 1;
    };
    for (const l of lines.slice(0, 8)) {
      if (looksLikeName(l)) { name = l; break; }
    }

    // Tidy up
    const tidy = (s) => s ? s.replace(/\s+/g, ' ').replace(/[•|]+/g, ' ').trim() : '';
    return {
      name: tidy(name),
      position: tidy(position),
      company: tidy(company),
      mobile: tidy(mobile),
      email: tidy(email),
      address: tidy(address)
    };
  }

  return { extract, parse };
})();

/* ========================================================================
   5. SYNC — Apps Script Web App POST + queue
   ======================================================================== */
const Sync = (() => {
  let _syncing = false;

  async function pushOne(entry) {
    const url = Settings.get(SettingsKey.scriptUrl);
    if (!url) throw new Error('Apps Script URL not set');

    // Build payload — sheet-friendly, no large image blobs by default.
    const payload = {
      id: entry.id,
      timestamp: new Date(entry.createdAt).toISOString(),
      name: entry.name || '',
      position: entry.position || '',
      company: entry.company || '',
      mobile: entry.mobile || '',
      email: entry.email || '',
      address: entry.address || '',
      remarks: entry.remarks || '',
      recruitment: entry.recruitment ? 'Yes' : 'No',
      consulting: entry.consulting ? 'Yes' : 'No',
      whatsappSent: entry.whatsappSent ? 'Yes' : 'No',
      contactSaved: entry.contactSaved ? 'Yes' : 'No',
      event: Settings.get(SettingsKey.event, APP.defaultEvent)
    };

    // Use text/plain to avoid CORS preflight on Apps Script
    const res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    if (!res.ok) throw new Error('Sync HTTP ' + res.status);
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (json && json.ok === false) throw new Error(json.error || 'Sync rejected');
    return true;
  }

  async function flush() {
    if (_syncing) return;
    if (!navigator.onLine) return;
    if (!Settings.get(SettingsKey.scriptUrl)) return;
    _syncing = true;
    UI.setSyncPill('syncing');
    const queue = await DB.queueAll();
    let pushed = 0, failed = 0;
    for (const q of queue) {
      try {
        const entry = await DB.get(q.id);
        if (!entry) { await DB.queueRemove(q.id); continue; }
        await pushOne(entry);
        entry.synced = true;
        entry.syncedAt = Date.now();
        await DB.put(entry);
        await DB.queueRemove(q.id);
        pushed++;
      } catch (e) {
        failed++;
        console.warn('[sync] failed for', q.id, e.message);
        q.attempts = (q.attempts || 0) + 1;
        q.lastError = e.message;
        const db = await DB.open();
        const tx = db.transaction(APP.syncStore, 'readwrite');
        tx.objectStore(APP.syncStore).put(q);
      }
    }
    _syncing = false;
    if (pushed) Utils.toast(`Synced ${pushed} entr${pushed === 1 ? 'y' : 'ies'}`, 'success');
    if (failed && pushed === 0) Utils.toast(`${failed} sync attempt(s) failed`, 'error');
    await UI.refreshAll();
  }

  async function testConnection() {
    const url = Settings.get(SettingsKey.scriptUrl);
    if (!url) { Utils.toast('Paste your Apps Script URL first', 'warning'); return; }
    try {
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'ping=1', { mode: 'cors' });
      if (res.ok) {
        Utils.toast('Apps Script reachable', 'success');
      } else {
        Utils.toast('HTTP ' + res.status, 'error');
      }
    } catch (e) {
      Utils.toast('Could not reach script — check URL', 'error');
    }
  }

  return { flush, pushOne, testConnection };
})();

/* ========================================================================
   6. WHATSAPP module
   ======================================================================== */
const WA = (() => {
  function buildMessage(entry) {
    const opts = [];
    if (entry.recruitment) opts.push('Recruitment');
    if (entry.consulting) opts.push('Consulting');
    const services = opts.length
      ? (opts.length === 2 ? 'Recruitment and Consulting' : opts[0])
      : 'our services';
    const event = Settings.get(SettingsKey.event, APP.defaultEvent);
    const date = Settings.get(SettingsKey.eventDate, APP.defaultEventDate);
    const firstName = (entry.name || '').split(' ')[0] || 'there';
    return [
      `Hello ${firstName},`,
      '',
      `It was a pleasure meeting you at ${event} on ${date}.`,
      '',
      `As discussed, sharing details regarding ${services}.`,
      '',
      'Please suggest a suitable time to connect next week.',
      '',
      'Regards,',
      APP.signOff,
      APP.signOffEmail
    ].join('\n');
  }

  /** Try native Web Share with files, else fall back to a deep-link helper. */
  async function open(entry, attachments) {
    const message = buildMessage(entry);
    const phone = Utils.normalizePhone(entry.mobile);

    // Copy message to clipboard (so even if share lacks text, user can paste)
    try { await navigator.clipboard.writeText(message); } catch (e) {}

    // Build attachment File list (PDFs + team photo). Skip any missing files
    // so a 404 on one (e.g. team.jpg not yet copied in) doesn't break the share.
    const files = [];
    for (const a of attachments) {
      try {
        const r = await fetch(a.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        if (blob && blob.size > 0) {
          files.push(new File([blob], a.name, { type: blob.type || 'application/octet-stream' }));
        }
      } catch (err) {
        console.warn('[wa] skipping attachment', a.name, err.message);
      }
    }

    // Prefer Web Share API with files (Android Chrome supports this best)
    if (navigator.canShare && files.length && navigator.canShare({ files })) {
      try {
        await navigator.share({
          files,
          title: 'Parth Sarathi Partners',
          text: message
        });
        return { method: 'webshare' };
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[wa] webshare failed', e);
      }
    }

    // Fallback: open WhatsApp chat with prefilled message, show attachment helper
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
      : `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener');
    return { method: 'deeplink', message };
  }

  return { buildMessage, open };
})();

/* ========================================================================
   7. CONTACT module — vCard
   ======================================================================== */
const Contact = (() => {
  function generateVCard(entry) {
    const fullName = (entry.name || 'Unknown') + ' - PSP JITO Jobs';
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${fullName}`,
      `N:${(entry.name || '').split(' ').reverse().join(';')};;;`,
    ];
    if (entry.company) lines.push(`ORG:${entry.company}`);
    if (entry.position) lines.push(`TITLE:${entry.position}`);
    if (entry.mobile) lines.push(`TEL;TYPE=CELL:${entry.mobile}`);
    if (entry.email) lines.push(`EMAIL;TYPE=WORK:${entry.email}`);
    if (entry.address) lines.push(`ADR;TYPE=WORK:;;${entry.address.replace(/\n/g, ', ')};;;;`);
    if (entry.remarks) lines.push(`NOTE:${entry.remarks.replace(/\n/g, ' ')}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  }

  function save(entry) {
    const vcard = generateVCard(entry);
    const safe = (entry.name || 'contact').replace(/[^\w\-]+/g, '_');
    Utils.download(`${safe}_PSP.vcf`, vcard, 'text/vcard;charset=utf-8');
  }

  return { save, generateVCard };
})();

/* ========================================================================
   8. EXPORT module
   ======================================================================== */
const ExportMod = (() => {
  function flatRows(entries) {
    return entries.map(e => ({
      Timestamp: new Date(e.createdAt).toLocaleString('en-IN'),
      Name: e.name || '',
      Position: e.position || '',
      Company: e.company || '',
      Mobile: e.mobile || '',
      Email: e.email || '',
      Address: e.address || '',
      Remarks: e.remarks || '',
      'Recruitment Selected': e.recruitment ? 'Yes' : 'No',
      'Consulting Selected': e.consulting ? 'Yes' : 'No',
      'WhatsApp Sent': e.whatsappSent ? 'Yes' : 'No',
      'Saved Contact': e.contactSaved ? 'Yes' : 'No',
      'Synced to Sheet': e.synced ? 'Yes' : 'No',
      Event: Settings.get(SettingsKey.event, APP.defaultEvent)
    }));
  }

  async function xlsx() {
    if (!window.XLSX) { Utils.toast('Excel engine still loading…', 'warning'); return; }
    const entries = await DB.getAll();
    if (!entries.length) { Utils.toast('No entries to export', 'warning'); return; }
    const rows = flatRows(entries);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    Utils.download(`PSP_Leads_${new Date().toISOString().slice(0,10)}.xlsx`, new Blob([out], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }));
    Utils.toast('Excel exported', 'success');
  }

  async function csv() {
    const entries = await DB.getAll();
    if (!entries.length) { Utils.toast('No entries to export', 'warning'); return; }
    const rows = flatRows(entries);
    const keys = Object.keys(rows[0]);
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const body = [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\r\n');
    Utils.download(`PSP_Leads_${new Date().toISOString().slice(0,10)}.csv`, body, 'text/csv;charset=utf-8');
    Utils.toast('CSV exported', 'success');
  }

  async function json() {
    const entries = await DB.getAll();
    if (!entries.length) { Utils.toast('No entries to export', 'warning'); return; }
    // Strip images for compact backup; keep full data otherwise
    const payload = entries.map(e => ({ ...e, frontImage: e.frontImage ? '[image]' : null, backImage: e.backImage ? '[image]' : null }));
    Utils.download(`PSP_Leads_${new Date().toISOString().slice(0,10)}.json`, JSON.stringify({
      exportedAt: new Date().toISOString(),
      version: APP.version,
      count: entries.length,
      entries: payload
    }, null, 2), 'application/json');
    Utils.toast('JSON exported', 'success');
  }

  return { xlsx, csv, json };
})();

/* ========================================================================
   9. UI — views, rendering, events
   ======================================================================== */
const UI = (() => {
  let _state = {
    front: null,   // dataURL
    back: null,    // dataURL
    editingId: null,
    filter: 'all',
    search: '',
    entries: []
  };

  /* ---------- View routing ---------- */
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('view-active'));
    const target = document.getElementById('view-' + name);
    if (target) target.classList.add('view-active');
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('nav-active', b.dataset.view === name);
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  /* ---------- Status pills ---------- */
  function setNetPill() {
    const el = document.getElementById('netPill');
    if (!el) return;
    if (navigator.onLine) {
      el.className = 'pill pill-online';
      el.querySelector('.pill-label').textContent = 'Online';
    } else {
      el.className = 'pill pill-offline';
      el.querySelector('.pill-label').textContent = 'Offline';
    }
  }
  function setSyncPill(state, count) {
    const el = document.getElementById('syncPill');
    const lbl = document.getElementById('syncPillLabel');
    if (!el || !lbl) return;
    if (state === 'syncing') {
      el.className = 'pill pill-syncing';
      lbl.textContent = 'Syncing…';
    } else if (state === 'pending') {
      el.className = 'pill pill-pending';
      lbl.textContent = `${count} pending`;
    } else {
      el.className = 'pill pill-synced';
      lbl.textContent = 'Synced';
    }
  }

  /* ---------- Card image preview ---------- */
  function setPreview(side, dataUrl) {
    const target = document.getElementById('preview' + (side === 'front' ? 'Front' : 'Back'));
    if (!target) return;
    if (dataUrl) {
      target.innerHTML = `<img alt="${side}" src="${dataUrl}" />`;
    } else {
      // restore default placeholder by reloading from initial markup — easier: rebuild
      target.innerHTML = side === 'front'
        ? `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M8 6V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1"/><circle cx="12" cy="13" r="3.2"/></svg><span>Front side</span>`
        : `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/></svg><span>Back side <small>(optional)</small></span>`;
    }
    document.getElementById('btnExtract').disabled = !_state.front;
  }

  /* ---------- Capture screen ---------- */
  function resetCapture() {
    _state.front = null;
    _state.back = null;
    _state.editingId = null;
    setPreview('front', null);
    setPreview('back', null);
    ['fName', 'fPosition', 'fCompany', 'fMobile', 'fEmail', 'fAddress', 'fRemarks'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('cRecruit').checked = false;
    document.getElementById('cConsult').checked = false;
    document.getElementById('btnAdd').textContent = '+ Add Entry';
    document.getElementById('btnExtract').disabled = true;
    document.getElementById('ocrProgress').classList.add('hidden');
  }

  function fillForm(parsed) {
    if (parsed.name)     document.getElementById('fName').value = parsed.name;
    if (parsed.position) document.getElementById('fPosition').value = parsed.position;
    if (parsed.company)  document.getElementById('fCompany').value = parsed.company;
    if (parsed.mobile)   document.getElementById('fMobile').value = parsed.mobile;
    if (parsed.email)    document.getElementById('fEmail').value = parsed.email;
    if (parsed.address)  document.getElementById('fAddress').value = parsed.address;
  }

  /* ---------- Entries rendering ---------- */
  function applyFilter(entries) {
    let list = entries;
    if (_state.filter === 'recruitment') list = list.filter(e => e.recruitment && !e.consulting);
    else if (_state.filter === 'consulting') list = list.filter(e => e.consulting && !e.recruitment);
    else if (_state.filter === 'both') list = list.filter(e => e.consulting && e.recruitment);
    else if (_state.filter === 'pending') list = list.filter(e => !e.synced);
    const q = _state.search.trim().toLowerCase();
    if (q) {
      list = list.filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.company || '').toLowerCase().includes(q) ||
        (e.mobile || '').toLowerCase().includes(q) ||
        (e.email || '').toLowerCase().includes(q) ||
        (e.position || '').toLowerCase().includes(q)
      );
    }
    return list;
  }

  function renderList() {
    const list = applyFilter(_state.entries);
    const el = document.getElementById('entryList');
    const empty = document.getElementById('emptyHistory');
    document.getElementById('historySummary').textContent =
      `${list.length} of ${_state.entries.length} lead${_state.entries.length === 1 ? '' : 's'}`;
    if (!list.length) {
      el.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    el.innerHTML = list.map(e => {
      const tags = [];
      if (e.recruitment) tags.push('<span class="tag tag-recruit">Recruitment</span>');
      if (e.consulting)  tags.push('<span class="tag tag-consult">Consulting</span>');
      tags.push(e.synced
        ? '<span class="tag tag-synced">Synced</span>'
        : '<span class="tag tag-pending">Pending</span>');
      if (e.whatsappSent) tags.push('<span class="tag tag-wa">WA sent</span>');
      if (e.contactSaved) tags.push('<span class="tag tag-contact">Contact saved</span>');
      const meta = [e.position, e.company, e.mobile].filter(Boolean).join(' · ');
      return `
        <div class="entry-card" data-id="${e.id}">
          <div class="entry-head">
            <div class="entry-info">
              <p class="entry-name">${Utils.escapeHtml(e.name || '(no name)')}</p>
              <p class="entry-meta">${Utils.escapeHtml(meta)}</p>
            </div>
          </div>
          <div class="entry-tags">${tags.join('')}</div>
          <div class="entry-actions">
            <button data-act="view" data-id="${e.id}">View</button>
            <button class="contact-btn" data-act="contact" data-id="${e.id}">Contact</button>
            <button class="wa-btn ${e.whatsappSent ? 'sent' : ''}" data-act="wa" data-id="${e.id}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20.5 3.5A11.6 11.6 0 0 0 12 0C5.5 0 .2 5.3.2 11.8c0 2.1.6 4.1 1.6 5.9L0 24l6.5-1.7a11.7 11.7 0 0 0 5.5 1.4h.01c6.5 0 11.8-5.3 11.8-11.8 0-3.1-1.2-6.1-3.3-8.4zM12 21.5h-.01a9.7 9.7 0 0 1-4.95-1.35l-.36-.21-3.85 1 1.02-3.76-.23-.38a9.6 9.6 0 0 1-1.48-5.16c0-5.36 4.37-9.7 9.74-9.7a9.7 9.7 0 0 1 9.74 9.7c0 5.36-4.37 9.7-9.74 9.7z"/></svg>
              ${e.whatsappSent ? 'Sent' : 'WhatsApp'}
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  /* ---------- Dashboard ---------- */
  function renderDashboard() {
    const all = _state.entries;
    const synced = all.filter(e => e.synced).length;
    const pending = all.length - synced;
    const wa = all.filter(e => e.whatsappSent).length;
    const contact = all.filter(e => e.contactSaved).length;
    const today = all.filter(e => Utils.isToday(e.createdAt)).length;
    const recOnly = all.filter(e => e.recruitment && !e.consulting).length;
    const conOnly = all.filter(e => e.consulting && !e.recruitment).length;
    const both = all.filter(e => e.recruitment && e.consulting).length;
    const max = Math.max(recOnly, conOnly, both, 1);

    document.getElementById('statTotal').textContent = all.length;
    document.getElementById('statSynced').textContent = synced;
    document.getElementById('statPending').textContent = pending;
    document.getElementById('statWa').textContent = wa;
    document.getElementById('statContact').textContent = contact;
    document.getElementById('statToday').textContent = today;
    document.getElementById('cRecruitCount').textContent = recOnly;
    document.getElementById('cConsultCount').textContent = conOnly;
    document.getElementById('cBothCount').textContent = both;
    document.getElementById('bRecruit').style.width = (recOnly / max * 100) + '%';
    document.getElementById('bConsult').style.width = (conOnly / max * 100) + '%';
    document.getElementById('bBoth').style.width = (both / max * 100) + '%';

    setSyncPill(pending > 0 ? 'pending' : 'synced', pending);
  }

  /* ---------- Modals ---------- */
  function openEntryModal(entry) {
    const body = document.getElementById('modalEntryBody');
    const rows = [
      ['Name', entry.name],
      ['Position', entry.position],
      ['Company', entry.company],
      ['Mobile', entry.mobile],
      ['Email', entry.email],
      ['Address', entry.address],
      ['Remarks', entry.remarks],
      ['Service', [entry.recruitment ? 'Recruitment' : null, entry.consulting ? 'Consulting' : null].filter(Boolean).join(' + ') || '—'],
      ['Captured', Utils.formatDate(entry.createdAt)],
      ['Synced', entry.synced ? Utils.formatDate(entry.syncedAt) : 'Pending'],
      ['WhatsApp', entry.whatsappSent ? Utils.formatDate(entry.whatsappSentAt) : 'Not sent'],
      ['Contact', entry.contactSaved ? 'Saved' : 'Not saved']
    ];
    let imgs = '';
    if (entry.frontImage || entry.backImage) {
      imgs = '<div class="modal-card-imgs">';
      if (entry.frontImage) imgs += `<img src="${entry.frontImage}" alt="front"/>`;
      if (entry.backImage) imgs += `<img src="${entry.backImage}" alt="back"/>`;
      imgs += '</div>';
    }
    const buttons = `
      <div class="btn-row btn-row-3" style="margin-top:14px">
        <button class="btn-ghost" data-modal-act="delete" data-id="${entry.id}">Delete</button>
        <button class="btn-ghost" data-modal-act="resync" data-id="${entry.id}">Re-sync</button>
        <button class="btn-secondary" data-modal-act="wa" data-id="${entry.id}">WhatsApp</button>
      </div>
    `;
    body.innerHTML = imgs + rows.map(([k, v]) => `
      <div class="modal-detail-row">
        <span class="modal-detail-label">${k}</span>
        <span class="modal-detail-val">${Utils.escapeHtml(v || '—')}</span>
      </div>
    `).join('') + buttons;
    document.getElementById('modalEntryTitle').textContent = entry.name || 'Lead details';
    document.getElementById('modalEntry').classList.remove('hidden');
  }

  function closeModal(name) {
    if (!name || name === 'entry') document.getElementById('modalEntry').classList.add('hidden');
    if (!name || name === 'whatsapp') document.getElementById('modalWhatsApp').classList.add('hidden');
  }

  function openWhatsAppHelper(entry, attachments) {
    const message = WA.buildMessage(entry);
    const body = document.getElementById('modalWaBody');
    const attachmentBtns = attachments.map(a => `
      <a class="wa-attachment" href="${a.url}" download="${a.name}">
        <span class="wa-att-icon">
          ${a.type === 'pdf'
            ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path fill="white" d="M9.5 15.5h-1v-3h1a1.5 1.5 0 1 1 0 3zm0-2h-.5v1h.5a.5.5 0 1 0 0-1zm3.5 2h-1v-3h1c1 0 1.5.7 1.5 1.5s-.5 1.5-1.5 1.5zm0-2h-.5v1h.5c.4 0 .5-.3.5-.5s-.1-.5-.5-.5zm3.5 2v-1.2h.5v-.8h-.5V13h.7v-.5h-1.2v3h.5z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>'
          }
        </span>
        <div style="flex:1;display:flex;flex-direction:column;gap:2px">
          <span>${a.label}</span>
          <span class="muted small">Tap to save → attach in WhatsApp</span>
        </div>
      </a>`).join('');

    body.innerHTML = `
      <div class="wa-step">
        <div class="wa-step-num">1</div>
        <div class="wa-step-body">
          <strong>WhatsApp opening now</strong> with the message pre-typed. Just tap <strong>Send</strong>.
          ${navigator.clipboard ? '<br><span class="muted small">Message also copied to clipboard.</span>' : ''}
        </div>
      </div>
      ${attachments.length ? `
      <div class="wa-step">
        <div class="wa-step-num">2</div>
        <div class="wa-step-body">
          <strong>Attach the file(s)</strong> below. Tap each to save to your phone, then in WhatsApp tap the attach (📎) icon and pick them.
          <div class="wa-attachment-list">${attachmentBtns}</div>
        </div>
      </div>` : ''}
      <div class="wa-step">
        <div class="wa-step-num">${attachments.length ? '3' : '2'}</div>
        <div class="wa-step-body">
          Done — close this and the entry will be marked as WhatsApp-sent.
        </div>
      </div>
      <button class="btn-secondary btn-full" style="margin-top:12px" data-modal-act="markWaDone" data-id="${entry.id}">Mark as sent</button>
    `;
    document.getElementById('modalWhatsApp').classList.remove('hidden');
  }

  /* ---------- Refresh everything ---------- */
  async function refreshAll() {
    _state.entries = await DB.getAll();
    renderList();
    renderDashboard();
    const queue = await DB.queueAll();
    setSyncPill(queue.length ? 'pending' : 'synced', queue.length);
  }

  return {
    showView, setNetPill, setSyncPill,
    setPreview, resetCapture, fillForm,
    renderList, renderDashboard,
    openEntryModal, openWhatsAppHelper, closeModal,
    refreshAll,
    get state() { return _state; }
  };
})();

/* ========================================================================
   10. EVENT WIRING + BOOT
   ======================================================================== */
async function handleFile(file, side) {
  if (!file) return;
  try {
    const dataUrl = await Utils.readImageAsDataURL(file, 1600, 0.82);
    UI.state[side] = dataUrl;
    UI.setPreview(side, dataUrl);
  } catch (e) {
    Utils.toast('Could not read image', 'error');
  }
}

async function runOCR() {
  const imgs = [UI.state.front, UI.state.back].filter(Boolean);
  if (!imgs.length) { Utils.toast('Add a card image first', 'warning'); return; }
  try {
    const { parsed } = await OCR.extract(imgs);
    UI.fillForm(parsed);
    Utils.toast('Details extracted — review and edit if needed', 'success');
  } catch (e) {
    console.error(e);
    Utils.toast('OCR failed: ' + e.message, 'error');
  }
}

async function saveEntry(ev) {
  ev.preventDefault();
  const entry = {
    id: UI.state.editingId || Utils.uid(),
    createdAt: UI.state.editingId ? (await DB.get(UI.state.editingId)).createdAt : Date.now(),
    name: document.getElementById('fName').value.trim(),
    position: document.getElementById('fPosition').value.trim(),
    company: document.getElementById('fCompany').value.trim(),
    mobile: document.getElementById('fMobile').value.trim(),
    email: document.getElementById('fEmail').value.trim(),
    address: document.getElementById('fAddress').value.trim(),
    remarks: document.getElementById('fRemarks').value.trim(),
    recruitment: document.getElementById('cRecruit').checked,
    consulting: document.getElementById('cConsult').checked,
    frontImage: UI.state.front,
    backImage: UI.state.back,
    synced: false,
    syncedAt: null,
    whatsappSent: false,
    whatsappSentAt: null,
    contactSaved: false
  };
  if (!entry.name && !entry.mobile && !entry.email) {
    Utils.toast('Need at least name, mobile, or email', 'warning');
    return;
  }
  await DB.put(entry);
  await DB.queueAdd(entry.id);
  Utils.toast('Entry saved locally', 'success');
  UI.resetCapture();
  await UI.refreshAll();
  Sync.flush().catch(() => {});
}

async function onListClick(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const entry = await DB.get(id);
  if (!entry) return;
  const act = btn.dataset.act;
  if (act === 'view') {
    UI.openEntryModal(entry);
  } else if (act === 'contact') {
    Contact.save(entry);
    entry.contactSaved = true;
    await DB.put(entry);
    Utils.toast('Contact downloaded — open .vcf to add to phone', 'success');
    await UI.refreshAll();
  } else if (act === 'wa') {
    const atts = [];
    if (entry.recruitment) atts.push({ url: APP.attachments.recruitment, name: 'PSP_Recruitment.pdf', label: 'Recruitment profile', type: 'pdf' });
    if (entry.consulting)  atts.push({ url: APP.attachments.consulting,  name: 'PSP_Consulting.pdf',  label: 'Consulting profile',  type: 'pdf' });
    atts.push({ url: APP.attachments.team, name: 'Srishti_Riddhi.jpg', label: 'Srishti & Riddhi', type: 'image' });
    const result = await WA.open(entry, atts);
    if (result.method === 'webshare') {
      entry.whatsappSent = true;
      entry.whatsappSentAt = Date.now();
      await DB.put(entry);
      await UI.refreshAll();
    } else {
      UI.openWhatsAppHelper(entry, atts);
    }
  }
}

async function onModalClick(ev) {
  const btn = ev.target.closest('[data-modal-act], [data-close]');
  if (!btn) return;
  if (btn.dataset.close) { UI.closeModal(btn.dataset.close); return; }
  const id = btn.dataset.id;
  const entry = await DB.get(id);
  if (!entry) return;
  const act = btn.dataset.modalAct;
  if (act === 'delete') {
    if (!confirm('Delete this lead from this device? (Already-synced rows stay in the sheet.)')) return;
    await DB.remove(id);
    await DB.queueRemove(id);
    UI.closeModal('entry');
    await UI.refreshAll();
    Utils.toast('Deleted', 'success');
  } else if (act === 'resync') {
    entry.synced = false;
    await DB.put(entry);
    await DB.queueAdd(id);
    Utils.toast('Re-queued for sync', 'success');
    UI.closeModal('entry');
    Sync.flush().catch(() => {});
  } else if (act === 'wa') {
    UI.closeModal('entry');
    document.querySelector(`button[data-act="wa"][data-id="${id}"]`)?.click();
  } else if (act === 'markWaDone') {
    entry.whatsappSent = true;
    entry.whatsappSentAt = Date.now();
    await DB.put(entry);
    await DB.queueAdd(id);   // re-queue so sheet picks up the status
    UI.closeModal('whatsapp');
    Utils.toast('Marked as WhatsApp sent', 'success');
    await UI.refreshAll();
    Sync.flush().catch(() => {});
  }
}

function wireEvents() {
  // Bottom nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => UI.showView(btn.dataset.view));
  });

  // Card upload / camera buttons
  document.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const side = btn.dataset.target;
      const action = btn.dataset.action;
      const inputId = (action === 'camera' ? 'camera' : 'file') + (side === 'front' ? 'Front' : 'Back');
      document.getElementById(inputId).click();
    });
  });
  ['fileFront', 'fileBack', 'cameraFront', 'cameraBack'].forEach(id => {
    document.getElementById(id).addEventListener('change', (ev) => {
      const side = id.toLowerCase().includes('front') ? 'front' : 'back';
      handleFile(ev.target.files[0], side);
      ev.target.value = ''; // allow re-selecting same file
    });
  });

  // OCR + form
  document.getElementById('btnExtract').addEventListener('click', runOCR);
  document.getElementById('entryForm').addEventListener('submit', saveEntry);
  document.getElementById('btnReset').addEventListener('click', () => {
    if (confirm('Clear the form?')) UI.resetCapture();
  });

  // History
  document.getElementById('entryList').addEventListener('click', onListClick);
  document.getElementById('searchInput').addEventListener('input', (e) => {
    UI.state.search = e.target.value;
    UI.renderList();
  });
  document.getElementById('filterChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    document.querySelectorAll('#filterChips .chip').forEach(x => x.classList.remove('chip-active'));
    c.classList.add('chip-active');
    UI.state.filter = c.dataset.filter;
    UI.renderList();
  });

  // Dashboard
  document.getElementById('btnForceSync').addEventListener('click', () => Sync.flush());

  // Settings
  const scriptInput = document.getElementById('settingScriptUrl');
  const eventInput = document.getElementById('settingEvent');
  const dateInput = document.getElementById('settingEventDate');
  scriptInput.value = Settings.get(SettingsKey.scriptUrl);
  eventInput.value = Settings.get(SettingsKey.event, APP.defaultEvent);
  dateInput.value = Settings.get(SettingsKey.eventDate, APP.defaultEventDate);
  scriptInput.addEventListener('change', () => Settings.set(SettingsKey.scriptUrl, scriptInput.value.trim()));
  eventInput.addEventListener('change', () => Settings.set(SettingsKey.event, eventInput.value.trim()));
  dateInput.addEventListener('change', () => Settings.set(SettingsKey.eventDate, dateInput.value.trim()));
  document.getElementById('btnTestSync').addEventListener('click', () => Sync.testConnection());
  document.getElementById('btnExportXlsx').addEventListener('click', () => ExportMod.xlsx());
  document.getElementById('btnExportCsv').addEventListener('click', () => ExportMod.csv());
  document.getElementById('btnExportJson').addEventListener('click', () => ExportMod.json());
  document.getElementById('btnClearAll').addEventListener('click', async () => {
    if (!confirm('Delete ALL local leads from this device? Synced rows in the Google Sheet remain untouched.')) return;
    await DB.clearAll();
    await UI.refreshAll();
    Utils.toast('Local data cleared', 'success');
  });

  // PWA install
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    document.getElementById('installHint').textContent = 'Tap below to add PSP Leads to your home screen.';
  });
  document.getElementById('btnInstall').addEventListener('click', async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      const { outcome } = await deferredInstall.userChoice;
      if (outcome === 'accepted') Utils.toast('Installed', 'success');
      deferredInstall = null;
    } else {
      Utils.toast('On iPhone: tap Share → "Add to Home Screen"', 'warning');
    }
  });

  // Modals
  document.getElementById('modalEntry').addEventListener('click', onModalClick);
  document.getElementById('modalWhatsApp').addEventListener('click', onModalClick);

  // Network state
  window.addEventListener('online', () => {
    UI.setNetPill();
    Sync.flush().catch(() => {});
  });
  window.addEventListener('offline', UI.setNetPill);

  // Periodic background sync (every 30s when tab visible)
  setInterval(() => {
    if (navigator.onLine && document.visibilityState === 'visible') {
      Sync.flush().catch(() => {});
    }
  }, 30000);
}

async function boot() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
    } catch (e) { console.warn('[sw] register failed', e); }
  }

  wireEvents();
  UI.setNetPill();
  await UI.refreshAll();

  // Best-effort: persistent storage so OS won't evict our IndexedDB
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch (e) {}
  }

  // Attempt initial sync (no-op if offline / no script URL)
  Sync.flush().catch(() => {});
}

document.addEventListener('DOMContentLoaded', boot);
