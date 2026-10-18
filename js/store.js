// Local persistence (localStorage) plus JSON export/import for backups and
// moving data between laptops (AirDrop / USB) without wifi.
(function (root) {
  'use strict';
  const PREFIX = 'trupower.';
  let storageOk = true;

  function read(k, dflt) {
    try { const s = localStorage.getItem(PREFIX + k); return s ? JSON.parse(s) : dflt; }
    catch (e) { storageOk = false; return dflt; }
  }
  function write(k, v) {
    try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; }
    catch (e) { storageOk = false; return false; }
  }
  function remove(k) { try { localStorage.removeItem(PREFIX + k); } catch (e) { /* ignore */ } }

  const DEFAULT_SETTINGS = { ourTeam: '', tbaKey: '', nSims: 3000, current: null, model: {}, autoSync: true };

  function loadSettings() { return Object.assign({}, DEFAULT_SETTINGS, read('settings', {})); }
  function saveSettings(s) { return write('settings', s); }

  function listEvents() { return read('index', []); }
  function loadEvent(key) { return read('event.' + key, null); }
  function saveEvent(ev) {
    ev.updated = Date.now();
    const ok = write('event.' + ev.key, ev);
    const idx = listEvents().filter(e => e.key !== ev.key);
    idx.push({ key: ev.key, name: ev.name, year: ev.year, updated: ev.updated });
    write('index', idx);
    return ok;
  }
  function deleteEvent(key) {
    remove('event.' + key);
    write('index', listEvents().filter(e => e.key !== key));
  }

  function usageKB() {
    try {
      let n = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(PREFIX)) n += k.length + (localStorage.getItem(k) || '').length;
      }
      return Math.round(n * 2 / 1024);
    } catch (e) { return null; }
  }

  function download(filename, obj) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Merge an imported event into an existing one: newest version of each match wins,
  // notes/stars/scouting are combined.
  function mergeEvent(cur, inc) {
    if (!cur) return inc;
    const byKey = {};
    for (const m of cur.matches || []) byKey[m.key] = m;
    for (const m of inc.matches || []) {
      const o = byKey[m.key];
      if (!o || (m.played && !o.played) || (m.played === o.played && (m.updated || 0) > (o.updated || 0))) byKey[m.key] = m;
    }
    cur.matches = root.Model.sortMatches(Object.values(byKey));
    cur.notes = Object.assign({}, inc.notes || {}, cur.notes || {});
    for (const t in inc.notes || {}) if (cur.notes[t] !== inc.notes[t] && !(cur.notes[t] || '').includes(inc.notes[t])) cur.notes[t] = [cur.notes[t], inc.notes[t]].filter(Boolean).join('\n');
    cur.starred = Object.assign({}, inc.starred || {}, cur.starred || {});
    if (inc.scouting && inc.scouting.rows) {
      cur.scouting = cur.scouting || { rows: [], map: {} };
      const seen = new Set(cur.scouting.rows.map(r => r.team + '|' + r.match + '|' + JSON.stringify(r.values)));
      for (const r of inc.scouting.rows) if (!seen.has(r.team + '|' + r.match + '|' + JSON.stringify(r.values))) cur.scouting.rows.push(r);
      cur.scouting.map = Object.assign({}, inc.scouting.map || {}, cur.scouting.map || {});
    }
    if (!cur.priors || !Object.keys(cur.priors).length) { cur.priors = inc.priors; cur.priorMeta = inc.priorMeta; }
    const teams = new Set(cur.teams.concat(inc.teams || []));
    cur.teams = [...teams].sort(root.Model.teamCmp);
    cur.teamNames = Object.assign({}, inc.teamNames || {}, cur.teamNames || {});
    return cur;
  }

  function loadCatalogue(year) { return read('catalogue.' + year, null); }
  function saveCatalogue(year, c) { return write('catalogue.' + year, c); }

  root.Store = {
    loadCatalogue, saveCatalogue,
    loadSettings, saveSettings, listEvents, loadEvent, saveEvent, deleteEvent, usageKB, download, mergeEvent,
    get ok() { return storageOk; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
