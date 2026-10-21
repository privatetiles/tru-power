#!/usr/bin/env node
// Download a season's data from The Blue Alliance for the backtests.
//   TBA_KEY=... node tools/fetch-tba.js <year> <out-dir> [--matches] [--oprs]
// Writes <out-dir>/events.json (/events/{year}/simple), and for every event except
// preseason: <out-dir>/matches/<key>.json and/or <out-dir>/oprs/<key>.json.
// Existing files are kept, so an interrupted download can simply be run again.
'use strict';
const fs = require('fs');
const path = require('path');

const [year, out] = process.argv.slice(2);
const want = { matches: process.argv.includes('--matches'), oprs: process.argv.includes('--oprs') };
const key = process.env.TBA_KEY;
if (!year || !out || !key || (!want.matches && !want.oprs)) {
  console.error('usage: TBA_KEY=... node tools/fetch-tba.js <year> <out-dir> [--matches] [--oprs]');
  process.exit(1);
}

async function get(p) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch('https://www.thebluealliance.com/api/v3' + p, { headers: { 'X-TBA-Auth-Key': key } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw new Error(p + ': ' + e.message);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const evFile = path.join(out, 'events.json');
  const events = fs.existsSync(evFile) ? JSON.parse(fs.readFileSync(evFile, 'utf8')) : await get('/events/' + year + '/simple');
  fs.writeFileSync(evFile, JSON.stringify(events));
  const keys = events.filter(e => e.event_type !== 100).map(e => e.key);
  const jobs = [];
  for (const kind of ['matches', 'oprs']) {
    if (!want[kind]) continue;
    fs.mkdirSync(path.join(out, kind), { recursive: true });
    for (const k of keys) {
      const f = path.join(out, kind, k + '.json');
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) jobs.push({ f, p: '/event/' + k + '/' + kind });
    }
  }
  let done = 0, next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      const data = await get(j.p);
      fs.writeFileSync(j.f, JSON.stringify(data == null ? [] : data));
      if (++done % 50 === 0) console.log(`  ${year}: ${done}/${jobs.length}`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`${year}: ${keys.length} events, ${jobs.length} files downloaded into ${out}`);
})().catch(e => { console.error(e.message); process.exit(1); });
