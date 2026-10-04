// Route planner: zones and dungeon runs placed on a level axis, plus notes pinned to a level.
// Uses the quest and dungeon data that js/app.js exposes as window.ForeverTimeline.
(() => {
  'use strict';

  // ---------- Tabs ----------
  // Wired up first so switching tabs still works if anything below fails.
  const TAB_KEY = 'forever-tab';
  let renderPlanner = null;
  function showTab(name) {
    document.querySelectorAll('[data-view]').forEach(el => { el.hidden = el.dataset.view !== name; });
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    try { localStorage.setItem(TAB_KEY, name); } catch { /* storage unavailable */ }
    if (name === 'planner') renderPlanner?.();
    else window.ForeverTimeline?.renderAll();   // refresh "Add to planner" buttons after route edits
  }
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  const T = window.ForeverTimeline;
  if (!T) return;
  const { DUNGEONS, QUESTS, questById, byKey, done, diffAt, questLocation, locHTML, esc, toast } = T;
  const ZONES = window.FOREVER_ZONES || [];
  const zoneByKey = Object.fromEntries(ZONES.map(z => [z.key, z]));

  const STORE_KEY = 'forever-planner-v1';
  const WOWHEAD = 'https://www.wowhead.com/forever/';
  const CLASSES = ['Druid', 'Hunter', 'Mage', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior'];
  const FACTION = { A: 'Alliance', H: 'Horde' };

  const EXAMPLE = {
    faction: 'A', cls: '', start: 1,
    steps: [
      { t: 'zone', k: 'dunmorogh', from: 1, end: 12 },
      { t: 'dungeon', k: 'hot', from: 12, end: 14 },
      { t: 'dungeon', k: 'rol', from: 14, end: 16 },
      { t: 'dungeon', k: 'wc', from: 16, end: 18 },
      { t: 'zone', k: 'westfall', from: 18, end: 20 },
      { t: 'dungeon', k: 'dm', from: 20, end: 22 },
    ],
  };

  // Notes every planner starts with. A browser gets each default once (DEFAULTS_KEY records the
  // version it has seen), so deleting one keeps it gone.
  // - To add a default, give it `since` = the new DEFAULTS_VERSION and bump DEFAULTS_VERSION.
  // - To change one, add its previous values to `was` and bump DEFAULTS_VERSION. A note matching
  //   every field given in a `was` entry is an untouched copy and gets updated; edited ones are left alone.
  const MARBLES = 'pGR_66uhwSY', GEAR = 'kh-Apd_qKGc';      // the two questline guide videos
  const def = (since, lv, text, quest, items, video, t = 0, was) => ({ since, lv, text, quest, items, video, t, ...(was && { was }) });
  const DEFAULT_NOTES = [
    def(3, 2, 'Bag of Marbles Questline Start', '47', ['1191'], MARBLES, 328,
      [{ lv: 2, text: 'Bag of Marbles Questline Start', quest: '47', items: ['1191'], video: MARBLES, t: 334 }]),
    def(1, 14, 'Sleeping bag chain begins for exp boost and bag (3% exp buff and 12 slot bag)', '79008', ['211527', '1652'], 'tILWPzAyqLQ', 0, [
      { lv: 13, text: 'Start the sleeping bag chain' },
      { lv: 14, text: 'Sleeping bag chain begins for exp boost and bag' },
      { lv: 14, text: 'Sleeping bag chain begins for exp boost and bag (3% exp buff and 12 slot bag)', quest: '79008', items: [], video: 'tILWPzAyqLQ', t: 0 },
    ]),
    def(3, 20, 'Light of Elune Questline Start', '1016', ['5816'], MARBLES, 465),
    def(3, 30, 'Skull of Impending Doom Questline Start', '727', ['4984'], MARBLES, 87,
      [{ lv: 30, text: 'Skull of Impending Doom Questline Start', quest: '727', items: ['4984'], video: MARBLES, t: 0 }]),
    def(3, 35, 'Nifty Stopwatch Questline Start', '734', ['2820'], MARBLES, 235),
    def(4, 44, 'Nogginfogger Elixir Questline Start', '2605', ['8529'], MARBLES, 566),
    def(4, 46, 'Rune of the Guard Captain Questline Start', '179913', ['19120'], GEAR, 162),
    def(4, 47, "Linken's Boomerang Questline Start", '3844', ['11902', '11904', '11905'], MARBLES, 694),
    def(4, 50, 'Songstone of Ironforge Questline Start', '4363', ['12548', '12543'], GEAR, 280),
    def(4, 51, 'Heartseeker Quest in Alterac Valley (PVP)', '8271', ['19107', '19106', '19108', '20648'], GEAR, 356),
    def(4, 52, 'Barov Peasant Collar Questline Start', '5341', ['14023'], MARBLES, 827),
    def(4, 52, 'Mark of Fordring Elite Escort Quest', '5944', ['15411', '15418', '15421', '16058', '15413'], GEAR, 221),
    def(4, 52, 'Wyrmhide Spaulders Questline Start', '4022', ['12066', '12082', '12083'], GEAR, 256),
    def(4, 54, 'Class specific Dire Maul trinket', '', [], GEAR, 425),
    def(4, 55, 'LBRS Gear & Ony Attunement Questline Start', '5001', ['13962', '13958', '13959', '13961', '13963'], GEAR, 527),
    def(4, 55, "Mirah's Song Questline Start", '5382', ['15806', '15805', '13544'], GEAR, 470),
    def(4, 56, 'UBRS Trinket Questline Start', '5089', ['13965', '13968', '13966'], GEAR, 601),
  ];
  const DEFAULTS_KEY = 'forever-planner-defaults';
  const DEFAULTS_VERSION = 4;
  const noteFields = d => ({ lv: d.lv, text: d.text, quest: d.quest, items: [...d.items], video: d.video, t: d.t, urls: [...(d.urls || [])] });
  EXAMPLE.notes = DEFAULT_NOTES.map(noteFields);

  const $ = sel => document.querySelector(sel);
  const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  let nextId = 1;
  const uid = () => `p${nextId++}`;

  // ---------- Plan state ----------
  // Steps: { t: 'zone', k, from, end }, { t: 'dungeon', k, wing?, from, end, pick: { questId: bool } },
  // or { t: 'custom', name, from, end }.
  // A step with from === end is a single point on the axis (a dungeon run that doesn't take a whole level).
  // Steps are kept sorted by level and may overlap, e.g. a dungeon run in the middle of a zone.
  // Notes: { lv, text, quest, items: [], video, t } pinned to a level: a Wowhead quest ID, Wowhead
  // item IDs, and a YouTube video ID with an optional start time in seconds.
  function clean(p) {
    const out = {
      faction: p?.faction === 'H' ? 'H' : 'A',
      cls: CLASSES.includes(p?.cls) ? p.cls : '',
      start: clampInt(p?.start, 1, 59, 1),
      steps: [],
      notes: [],
    };
    // Older routes had no `from`: each step started where the previous one ended.
    let chain = out.start;
    for (const s of Array.isArray(p?.steps) ? p.steps : []) {
      const from = s?.from != null ? clampInt(s.from, 1, 60, chain) : chain;
      const end = Math.max(from, clampInt(s?.end, 1, 60, from));
      if (s?.t === 'zone' && zoneByKey[s.k]) {
        out.steps.push({ id: uid(), t: 'zone', k: s.k, from, end });
      } else if (s?.t === 'dungeon' && byKey[s.k]) {
        const wing = byKey[s.k].wings?.some(w => w.name === s.wing) ? s.wing : undefined;
        const pick = {};
        for (const [id, v] of Object.entries(s.pick || {})) if (/^\d+$/.test(id) && typeof v === 'boolean') pick[id] = v;
        out.steps.push({ id: uid(), t: 'dungeon', k: s.k, wing, from, end, pick });
      } else if (s?.t === 'custom' && String(s.name ?? '').trim()) {
        out.steps.push({ id: uid(), t: 'custom', name: String(s.name).trim().slice(0, 60), from, end });
      } else continue;
      chain = end;
    }
    for (const n of Array.isArray(p?.notes) ? p.notes : []) {
      const note = cleanNote(n);
      if (note) out.notes.push(note);
    }
    sortSteps(out);
    return out;
  }

  // A saved or shared note, including older shapes: a single `quest`/`url`, or a `links` list mixing
  // quest IDs, web addresses and plain text. From those, recognised quests, items and videos go in
  // their own fields, other web addresses into `urls`, and plain text is added to the note text.
  function cleanNote(n) {
    let text = String(n?.text ?? '').trim();
    if (!text) return null;
    const v = parseVideo(n.video ? `${n.video}${n.t ? `?t=${n.t}` : ''}` : '');
    const note = { id: uid(), lv: clampInt(n.lv, 1, 60, 1), quest: parseQuest(n.quest).quest || '', items: [], video: v.video || '', t: v.t || 0, urls: [] };
    for (const i of Array.isArray(n.items) ? n.items : []) {
      const id = parseItem(i).item;
      if (id && !note.items.includes(id)) note.items.push(id);
    }
    for (const u of Array.isArray(n.urls) ? n.urls : []) {
      const url = parseUrl(u).url;
      if (url && !note.urls.includes(url)) note.urls.push(url);
    }
    const extra = [];
    for (const raw of [...(Array.isArray(n.links) ? n.links : []), n.url]) {
      const s = String(raw ?? '').trim();
      if (!s) continue;
      const q = parseQuest(s), it = parseItem(s), vid = /^https?:/i.test(s) ? parseVideo(s) : {}, url = parseUrl(s).url;
      if (q.quest && !note.quest) note.quest = q.quest;
      else if (it.item) { if (!note.items.includes(it.item)) note.items.push(it.item); }
      else if (vid.video && !note.video) Object.assign(note, { video: vid.video, t: vid.t });
      else if (url) { if (!note.urls.includes(url)) note.urls.push(url); }
      else if (!q.quest) extra.push(s);
    }
    if (extra.length) text += ` (${extra.join(', ')})`;
    note.text = text.slice(0, MAX_TEXT);
    note.items = note.items.slice(0, MAX_ITEMS);
    note.urls = note.urls.slice(0, MAX_URLS);
    return note;
  }

  // Note fields. Each takes a bare ID or a full link and returns the ID, {} when empty, or { error }.
  const MAX_TEXT = 300, MAX_ITEMS = 10, MAX_URLS = 10;
  const wowheadId = (s, kind) => s.match(new RegExp(`wowhead\\.com/(?:[\\w-]+/)*${kind}=(\\d+)`, 'i'))?.[1];

  function parseQuest(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return {};
    const id = /^\d{1,7}$/.test(s) ? s : wowheadId(s, 'quest');
    return id ? { quest: id } : { error: `Enter a quest ID like 727, or its Wowhead link.` };
  }
  function parseItem(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return {};
    const id = /^\d{1,7}$/.test(s) ? s : wowheadId(s, 'item');
    return id ? { item: id } : { error: `“${s.slice(0, 40)}” isn’t an item ID like 4984, or a Wowhead item link.` };
  }
  function parseItems(raw) {
    const items = [];
    for (const part of String(raw ?? '').split(',')) {
      const r = parseItem(part);
      if (r.error) return r;
      if (r.item && !items.includes(r.item)) items.push(r.item);
    }
    return items.length > MAX_ITEMS ? { error: `A note can have up to ${MAX_ITEMS} items.` } : { items };
  }

  // A YouTube video: the 11-character ID, optionally with a time (pGR_66uhwSY?t=465), or a
  // youtube.com / youtu.be link. Times can be seconds (465, 465s) or 7m45s / 1h2m3s.
  function parseVideo(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return {};
    let id, time;
    const bare = s.match(/^([\w-]{11})(?:[?&#]?t=(\S+))?$/);
    if (bare) [, id, time] = bare;
    else {
      try {
        const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        const host = u.hostname.replace(/^(www|m)\./, '');
        if (host === 'youtu.be') id = u.pathname.slice(1);
        else if (host === 'youtube.com') id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1];
        time = u.searchParams.get('t') || u.searchParams.get('start');
      } catch { /* not a link */ }
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return { error: 'Enter a YouTube video ID like pGR_66uhwSY, or a YouTube link.' };
    const m = String(time ?? '').match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    const t = m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
    return { video: id, t };
  }

  // Any web address: http(s), with https:// added when it's left off. Other schemes are refused.
  function parseUrl(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return {};
    const bad = { error: `“${s.slice(0, 40)}” isn’t a web address like https://example.com.` };
    const scheme = /^https?:\/\//i.test(s);
    if (!scheme && !/^[^\s/:]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(s)) return bad;
    try {
      const u = new URL(scheme ? s : `https://${s}`);
      return u.hostname.includes('.') && u.href.length <= 500 ? { url: u.href } : bad;
    } catch { return bad; }
  }
  function parseUrls(raw) {
    const urls = [];
    for (const part of String(raw ?? '').split(',')) {
      const r = parseUrl(part);
      if (r.error) return r;
      if (r.url && !urls.includes(r.url)) urls.push(r.url);
    }
    return urls.length > MAX_URLS ? { error: `A note can have up to ${MAX_URLS} links.` } : { urls };
  }

  // Validates the note form; returns the note's values or { error }.
  function readNote(f) {
    const lvRaw = String(f.lv).trim();
    const lv = Math.round(Number(lvRaw));
    const text = String(f.text).trim();
    if (!lvRaw || !(lv >= 1 && lv <= 60)) return { error: 'Enter a level from 1 to 60.' };
    if (!text) return { error: 'Enter the note text.' };
    const q = parseQuest(f.quest);
    if (q.error) return q;
    const it = parseItems(f.items);
    if (it.error) return it;
    const v = parseVideo(f.video);
    if (v.error) return v;
    const u = parseUrls(f.urls);
    if (u.error) return u;
    return { lv, text: text.slice(0, MAX_TEXT), quest: q.quest || '', items: it.items, video: v.video || '', t: v.t || 0, urls: u.urls };
  }

  // Level order; a zone or longer run comes before a point that starts at the same level.
  function sortSteps(p) {
    p.steps = p.steps.map((s, i) => [s, i])
      .sort(([a, i], [b, j]) => a.from - b.from || (b.end - b.from) - (a.end - a.from) || i - j)
      .map(([s]) => s);
  }

  // What gets saved and shared: the plan without the in-memory ids.
  function portable(p) {
    return {
      faction: p.faction, cls: p.cls, start: p.start,
      steps: p.steps.map(({ id, ...s }) => {
        if (s.pick && !Object.keys(s.pick).length) delete s.pick;
        if (!s.wing) delete s.wing;
        return s;
      }),
      notes: p.notes.map(n => ({
        lv: n.lv, text: n.text,
        ...(n.quest && { quest: n.quest }), ...(n.items.length && { items: n.items }),
        ...(n.video && { video: n.video }), ...(n.video && n.t && { t: n.t }), ...(n.urls.length && { urls: n.urls }),
      })),
    };
  }

  function load() {
    try { return clean(JSON.parse(localStorage.getItem(STORE_KEY)) || {}); }
    catch { return clean({}); }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(portable(plan))); }
    catch { /* storage unavailable */ }
  }

  // Brings a browser's notes up to the current defaults: an untouched copy of an older version is
  // updated, and a default newer than the browser has seen is added unless a note for the same quest
  // (or with the same text) is already there. Defaults the browser already had and the user edited
  // or deleted are left alone.
  const sameText = (a, b) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
  const matchesWas = (n, w) => Object.entries(w).every(([k, v]) =>
    (k === 'items' ? n.items.join(',') === v.join(',') : n[k] === v));
  function addDefaultNotes(p) {
    let seen = 0;
    try { seen = Number(localStorage.getItem(DEFAULTS_KEY)) || 0; } catch { /* storage unavailable */ }
    if (seen >= DEFAULTS_VERSION) return false;
    for (const d of DEFAULT_NOTES) {
      const stale = p.notes.find(n => (d.was || []).some(w => matchesWas(n, w)));
      if (stale) { Object.assign(stale, noteFields(d)); continue; }
      if (d.since <= seen) continue;
      if (p.notes.some(n => (d.quest && n.quest === d.quest) || sameText(n.text, d.text))) continue;
      p.notes.push({ id: uid(), ...noteFields(d) });
    }
    try { localStorage.setItem(DEFAULTS_KEY, String(DEFAULTS_VERSION)); } catch { /* storage unavailable */ }
    return true;
  }

  let plan = load();
  if (addDefaultNotes(plan)) save();
  const open = new Set();          // step ids whose details are expanded

  // ---------- Share links ----------
  const b64url = {
    enc: str => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    dec: s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))),
  };
  function shareLink() {
    return `${location.href.split('#')[0]}#plan=${b64url.enc(JSON.stringify(portable(plan)))}`;
  }
  function importFromHash() {
    const m = location.hash.match(/^#plan=([\w-]+)$/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    let shared;
    try { shared = clean(JSON.parse(b64url.dec(m[1]))); }
    catch { toast('That share link is broken.'); return true; }
    if (plan.steps.length || plan.notes.length) {
      if (!confirm('Replace your current route with the shared one?')) return true;
    }
    plan = shared;
    open.clear();
    save();
    toast('Shared route loaded');
    return true;
  }

  // ---------- Derived data ----------
  const stepName = s => s.t === 'custom' ? s.name : s.t === 'zone' ? zoneByKey[s.k].name : byKey[s.k].name + (s.wing ? ` · ${s.wing}` : '');
  const dungeonRange = s => (s.wing && byKey[s.k].wings?.find(w => w.name === s.wing)) || byKey[s.k];
  // Where a dungeon goes when it's dropped in as a point: its suggested level, or a little above its minimum.
  const suggestedLevel = d => d.guide?.at ?? Math.min(d.max, d.min + 2);
  const routeEnd = () => plan.steps.reduce((m, s) => Math.max(m, s.end), plan.start);

  function prepQuests(s) {
    return QUESTS.filter(q => q.d === s.k
      && (q.side === 'B' || q.side === plan.faction)
      && (!s.wing || !q.wing || q.wing === s.wing)
      && !(q.classes && plan.cls && !q.classes.includes(plan.cls)));
  }
  // By default take every quest except profession quests, and class quests when no class is set.
  const defaultTake = q => !q.profession && !(q.classes && !plan.cls);
  const taking = (s, q) => s.pick?.[q.id] ?? defaultTake(q);

  function warnings(s) {
    const { from, end } = s;
    const w = [];
    if (s.t === 'custom') return w;
    if (s.t === 'zone') {
      const z = zoneByKey[s.k];
      if (z.side !== 'C' && z.side !== plan.faction) w.push(['warn', `${z.name} is a ${FACTION[z.side]} zone.`]);
      if (from === end) w.push(['warn', 'Covers no levels. Drag its right handle to stretch it.']);
      if (from > z.max) w.push(['bad', `You’ve outleveled ${z.name} (${z.min}–${z.max}) before you get here.`]);
      else if (from < z.min - 1) w.push(['bad', `Under-leveled: ${z.name} is ${z.min}–${z.max}, and you arrive at ${from}.`]);
      else if (end > z.max + 2) w.push(['warn', `Most quests in ${z.name} go grey after ${z.max + 2}.`]);
      return w;
    }
    const d = byKey[s.k];
    const r = dungeonRange(s);
    const g = !s.wing && d.guide;
    if (g && from < g.hard) w.push(['bad', `Entering at ${from}, below the suggested minimum of ${g.hard}.`]);
    else if (g && from < g.medium) w.push(['warn', `A hard run at ${from}. ${g.medium}+ is more comfortable.`]);
    else if (!g && from < r.min - 2) w.push(['bad', `Entering at ${from}, well below ${r.min}–${r.max}.`]);
    else if (!g && from < r.min) w.push(['warn', `Entering at ${from}, below ${r.min}–${r.max}.`]);
    else if (from > r.max) w.push(['warn', `Outleveled: ${stepName(s)} is ${r.min}–${r.max}.`]);
    const picked = prepQuests(s).filter(q => taking(s, q));
    const red = picked.filter(q => diffAt(q, from) === 'red').length;
    const grey = picked.filter(q => diffAt(q, from) === 'grey').length;
    if (red) w.push(['warn', `${red} picked quest${red > 1 ? 's are' : ' is'} still red at ${from}. Run this later, or untick ${red > 1 ? 'them' : 'it'}.`]);
    if (grey) w.push(['warn', `${grey} picked quest${grey > 1 ? 's are' : ' is'} already grey at ${from}.`]);
    return w;
  }

  // Levels between the starting level and the end of the route that no step spans.
  function gaps() {
    const out = [];
    let cursor = plan.start;
    for (const s of plan.steps) {
      if (s.end <= s.from) continue;
      if (s.from > cursor) out.push([cursor, s.from]);
      cursor = Math.max(cursor, s.end);
    }
    const last = routeEnd();
    if (last > cursor) out.push([cursor, last]);
    return out;
  }

  // Steps a note falls in: every step covering its level, or failing that, the steps ending there.
  function noteOwners(n) {
    const covering = plan.steps.filter(s => s.from === s.end ? n.lv === s.from : n.lv >= s.from && n.lv < s.end);
    return covering.length ? covering : plan.steps.filter(s => s.end === n.lv);
  }

  // ---------- Rendering ----------
  // The axis always covers every level, 1–60.
  const AMIN = 1, AMAX = 60;
  const pct = L => ((Math.max(AMIN, Math.min(AMAX, L)) - AMIN) / (AMAX - AMIN)) * 100;

  // ---------- Level filter ----------
  // "Your level" is shared with the Timeline tab. Like there, the planner can hide or fade steps and
  // notes outside your level (+1); those two settings are the planner's own, remembered per browser.
  const VIEW_KEY = 'forever-planner-view';
  const view = { near: false, fadeFar: false };
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY)) || {};
    for (const k of Object.keys(view)) if (typeof v[k] === 'boolean') view[k] = v[k];
  } catch { /* storage unavailable */ }
  const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* storage unavailable */ } };
  const myLevel = () => T.getLevel?.() ?? 15;
  const stepNear = (s, L) => s.from <= L + 1 && s.end >= L;
  const noteNear = (n, L) => n.lv >= L && n.lv <= L + 1;

  function gridHTML(L) {
    let h = '<div class="grid" aria-hidden="true">';
    for (const [a, b] of gaps()) h += `<i class="gap" style="left:${pct(a)}%;width:${pct(b) - pct(a)}%"></i>`;
    for (let lv = AMIN; lv <= AMAX; lv++) h += `<i class="gl${lv % 5 === 0 ? ' major' : ''}" style="left:${pct(lv)}%"></i>`;
    h += '</div><div class="grid top" aria-hidden="true">';
    for (const n of plan.notes) {
      if (n.lv >= AMIN && n.lv <= AMAX) h += `<i class="note-line" style="left:${pct(n.lv)}%"></i>`;
    }
    h += `<i class="you" style="left:${pct(L)}%"></i>`;
    return h + '</div>';
  }

  function axisHTML() {
    let ticks = '';
    for (let L = AMIN; L <= AMAX; L++) {
      ticks += L % 5 === 0 || L === AMIN
        ? `<span class="tick" style="left:${pct(L)}%">${L}</span>`
        : `<span class="tick minor" style="left:${pct(L)}%"></span>`;
    }
    for (const n of plan.notes) {
      if (n.lv >= AMIN && n.lv <= AMAX) {
        ticks += `<span class="note-flag" style="left:${pct(n.lv)}%" title="Level ${n.lv}: ${esc(n.text)}">⚑</span>`;
      }
    }
    return `<div class="row axis"><div class="label">Step</div><div class="track">${ticks}</div></div>`;
  }

  // Bar and handle positions for a level range; a point gets a fixed-size marker with handles beside it.
  function barGeometry(from, end) {
    const l = pct(from);
    if (from === end) {
      return { bar: `left:calc(${l}% - 9px);width:18px`, hl: `left:calc(${l}% - 17px)`, hr: `left:calc(${l}% + 9px)` };
    }
    const r = pct(end);
    return { bar: `left:${l}%;width:${r - l}%`, hl: `left:calc(${l}% - 8px)`, hr: `left:${r}%` };
  }

  function barHTML(s) {
    const g = barGeometry(s.from, s.end);
    const point = s.from === s.end;
    const tip = s.t === 'dungeon' ? ` data-tip="d:${s.k}${s.wing ? ':' + esc(s.wing) : ''}"` : ` title="${esc(stepName(s))}: ${s.from}–${s.end}"`;
    const cls = `pbar ${s.t}${point ? ' point' : ''}${s.t === 'dungeon' && byKey[s.k].type === 'new' ? ' is-new' : ''}`;
    return `
      <span class="ph l" style="${g.hl}" data-drag="from" title="Drag to change the start level"></span>
      <span class="${cls}" style="${g.bar}" data-drag="move"${tip}>${point ? '' : `${s.from}–${s.end}`}</span>
      <span class="ph r" style="${g.hr}" data-drag="end" title="Drag to change the end level"></span>`;
  }

  function stepRow(s, i, notesHere, far) {
    const w = warnings(s);
    const isOpen = open.has(s.id);
    const worst = w.find(v => v[0] === 'bad') || w[0];
    const warnIco = worst ? `<span class="warn-ico ${worst[0]}" title="${esc(w.map(v => v[1]).join('\n'))}">⚠</span>` : '';
    const noteIco = notesHere.length ? `<span class="note-ico" title="${esc(notesHere.map(n => `${n.lv}: ${n.text}`).join('\n'))}">⚑</span>` : '';
    const prep = s.t === 'dungeon'
      ? (() => { const qs = prepQuests(s); return `<span class="prep-badge" title="Quests you’re taking">⬥ ${qs.filter(q => taking(s, q)).length}/${qs.length}</span>`; })()
      : '';
    const name = esc(stepName(s));
    return `
      <div class="row pstep ${s.t}${isOpen ? ' open' : ''}${far ? ' far' : ''}" data-sid="${s.id}">
        <div class="label">
          <span class="pnum">${i + 1}</span>
          <button type="button" class="pname" data-pstep="${s.id}" aria-expanded="${isOpen}">${name}</button>
          ${s.t === 'dungeon' && byKey[s.k].type === 'new' ? '<span class="new-tag">New</span>' : ''}
          ${prep}${warnIco}${noteIco}
          <span class="spacer"></span>
          <input type="number" class="num plv" min="1" max="60" step="1" value="${s.from}" data-from="${s.id}" aria-label="Level you start ${name} at">
          <span class="dim">→</span>
          <input type="number" class="num plv" min="1" max="60" step="1" value="${s.end}" data-end="${s.id}" aria-label="Level you leave ${name} at">
        </div>
        <div class="track" data-pstep="${s.id}">${barHTML(s)}</div>
      </div>
      ${isOpen ? drawerHTML(s, w, notesHere) : ''}`;
  }

  function prepQuestHTML(s, q, L) {
    const take = taking(s, q);
    const isDone = done.has(q.id);
    const cls = (q.classes || []).map(c => `<span class="tag tag-class c-${esc(c)}">${esc(c)}</span>`).join('');
    const prof = q.profession ? `<span class="tag tag-class c-prof">${esc(q.profession)}</span>` : '';
    return `
      <li class="${take ? '' : 'skipped'}${isDone ? ' done' : ''}">
        <label class="check"><input type="checkbox" data-take="${q.id}"${take ? ' checked' : ''}><span class="sr">Take ${esc(q.name)}</span></label>
        <a href="#" class="d-${diffAt(q, L)}" data-goto="${q.id}" data-tip="q:${q.idx}">${isDone ? '<span class="done-mark" aria-label="Completed">✓</span>' : ''}${esc(q.name)}</a>
        <span class="dim small">${q.from}–${q.to}</span>
        ${cls}${prof}
        <span class="spacer"></span>
        ${locHTML(questLocation(q.id))}
      </li>`;
  }

  function dungeonDetail(s) {
    const qs = prepQuests(s).sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
    if (!qs.length) return `<h4>Quest pickups</h4><p class="dim">No ${FACTION[plan.faction]} quest data for this dungeon yet.</p>`;
    // Group by where each quest starts so the pickups read as a route: towns first, inside the dungeon last.
    const groups = new Map();
    for (const q of qs) {
      const loc = questLocation(q.id);
      const key = !loc ? 'Unknown location' : loc.inside ? loc.place : (loc.pt?.zone || loc.place.split(',')[0]).trim();
      if (!groups.has(key)) groups.set(key, { inside: !loc || !!loc.inside, list: [] });
      groups.get(key).list.push(q);
    }
    const ordered = [...groups.entries()].sort((a, b) => a[1].inside - b[1].inside);
    const n = qs.filter(q => taking(s, q)).length;
    return `
      <h4>Quest pickups <span class="dim">· taking ${n} of ${qs.length} · name colours show difficulty at ${s.from}</span></h4>
      ${ordered.map(([place, g]) => `
        <div class="pickup-group">
          <div class="pickup-place">${esc(place)}</div>
          <ul class="ref-quests">${g.list.map(q => prepQuestHTML(s, q, s.from)).join('')}</ul>
        </div>`).join('')}
      <p class="dim small">Untick quests you’ll skip. Click a quest to open it on the timeline, where you can mark it complete.</p>`;
  }

  function zoneDetail(s) {
    const { from, end } = s;
    const z = zoneByKey[s.k];
    const inRoute = new Set(plan.steps.filter(x => x.t === 'dungeon').map(x => x.k));
    const here = QUESTS.filter(q => {
      if (q.side !== 'B' && q.side !== plan.faction) return false;
      if (q.classes && plan.cls && !q.classes.includes(plan.cls)) return false;
      if (diffAt(q, from) === 'grey') return false;
      const loc = questLocation(q.id);
      return loc && !loc.inside && (loc.pt?.zone === z.name || loc.place.split(',')[0].trim() === z.name);
    }).sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
    const near = DUNGEONS.filter(d => d.min <= end && d.max >= from).sort((a, b) => a.min - b.min);
    return `
      ${z.note ? `<p class="dim">${esc(z.note)}</p>` : ''}
      <div class="drawer-grid">
        <div>
          <h4>Dungeon quests that start in ${esc(z.name)}</h4>
          ${here.length ? `<ul class="ref-quests">${here.map(q => `
            <li class="${done.has(q.id) ? 'done' : ''}">
              <a href="#" class="d-${diffAt(q, from)}" data-goto="${q.id}" data-tip="q:${q.idx}">${done.has(q.id) ? '<span class="done-mark">✓</span>' : ''}${esc(q.name)}</a>
              <span class="dim small">${esc(byKey[q.d]?.name || '')}</span>
              ${inRoute.has(q.d) ? '<span class="tag">In route</span>' : ''}
              <span class="spacer"></span>
              ${locHTML(questLocation(q.id))}
            </li>`).join('')}</ul>` : '<p class="dim">None that aren’t grey by the time you get here.</p>'}
        </div>
        <div>
          <h4>Dungeons in range (${from}–${end})</h4>
          ${near.length ? `<ul class="ref-quests">${near.map(d => `
            <li>
              <span>${esc(d.name)}</span>
              <span class="dim small">${d.min}–${d.max} · ${esc(d.zone)}</span>
              ${inRoute.has(d.key) ? '<span class="tag">In route</span>' : ''}
              <span class="spacer"></span>
              <button type="button" class="wow-btn small" data-insert="${d.key}">Add at ${Math.max(from, Math.min(end, suggestedLevel(d)))}</button>
            </li>`).join('')}</ul>` : '<p class="dim">None.</p>'}
        </div>
      </div>`;
  }

  function drawerHTML(s, w, notesHere) {
    const d = s.t === 'dungeon' ? byKey[s.k] : null;
    const z = s.t === 'zone' ? zoneByKey[s.k] : null;
    const sub = z ? `Zone ${z.min}–${z.max}` : d ? `${esc(d.zone)} · ${dungeonRange(s).min}–${dungeonRange(s).max}` : 'Custom step';
    const wingSel = d?.wings ? `
      <select data-wing aria-label="Wing">
        <option value="">All wings</option>
        ${d.wings.map(x => `<option${x.name === s.wing ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
      </select>` : '';
    return `
      <div class="row drawer pdrawer" data-sid="${s.id}">
        <div class="drawer-body">
          <div class="drawer-head">
            <b class="pd-title">${esc(stepName(s))}</b>
            <span class="dim">${s.from === s.end ? `At level ${s.from}` : `Levels ${s.from}–${s.end}`} · ${sub}</span>
            ${wingSel}
            ${d ? `<button type="button" class="wow-btn small" data-ref="${s.k}">📖 Quick reference</button>` : ''}
            <span class="spacer"></span>
            <button type="button" class="wow-btn small" data-remove>Remove</button>
            <button type="button" class="close-x" data-pstep="${s.id}" aria-label="Close details">✕</button>
          </div>
          ${notesHere.map(n => `<p class="pnote">⚑ <b>At ${n.lv}:</b> ${esc(n.text)}${noteLinkHTML(n)}</p>`).join('')}
          ${w.map(([k, t]) => `<p class="pwarn ${k}">⚠ ${esc(t)}</p>`).join('')}
          ${d ? dungeonDetail(s) : z ? zoneDetail(s) : ''}
        </div>
      </div>`;
  }

  // ---------- Wowhead names ----------
  // Quest and item names come from Wowhead's tooltip data and are cached in the browser, so each is
  // fetched once. Until a name arrives (or if the lookup fails) the link shows "Quest 727" / "Item 4984".
  const NAMES_KEY = 'forever-wowhead-names';
  const QUALITY = ['q-poor', 'q-common', 'q-uncommon', 'q-rare', 'q-epic', 'q-legendary'];
  let whNames = {};
  try { whNames = JSON.parse(localStorage.getItem(NAMES_KEY)) || {}; } catch { /* storage unavailable */ }
  const whTried = new Set();     // lookups started this session, so a failure isn't retried every render

  // Wowhead's Forever data doesn't have everything yet, so a lookup falls back to Classic, and the
  // link then points at the Classic page.
  const WH_ENVS = [{ env: 16, path: 'forever' }, { env: 4, path: 'classic' }];
  // `fallback` is a name we already know (a dungeon quest from our own data) to show until Wowhead's arrives.
  function whLinkHTML(kind, id, fallback) {
    const key = `${kind}:${id}`;
    const known = whNames[key];
    const cls = known?.quality != null ? ` class="${QUALITY[known.quality] || ''}"` : '';
    const href = `https://www.wowhead.com/${known?.path || 'forever'}/${kind}=${id}`;
    const label = known?.name || fallback || `${kind === 'item' ? 'Item' : 'Quest'} ${id}`;
    return `<a href="${href}" target="_blank" rel="noopener" data-wh="${key}"${cls}>${esc(label)}</a>`;
  }
  async function lookupWowhead(kind, id) {
    for (const { env, path } of WH_ENVS) {
      const r = await fetch(`https://nether.wowhead.com/tooltip/${kind}/${id}?dataEnv=${env}&locale=0`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.name) return { name: String(j.name).slice(0, 120), path, ...(kind === 'item' && Number.isInteger(j.quality) && { quality: j.quality }) };
    }
    return null;
  }
  // An ID Wowhead doesn't know is remembered as { missing: time } and not looked up again for a week.
  const RETRY_MISSING = 7 * 24 * 3600 * 1000;
  function fillWowheadNames() {
    document.querySelectorAll('#planner [data-wh]').forEach(a => {
      const key = a.dataset.wh;
      const known = whNames[key];
      if (known?.name || (known?.missing && Date.now() - known.missing < RETRY_MISSING) || whTried.has(key)) return;
      whTried.add(key);
      const [kind, id] = key.split(':');
      lookupWowhead(kind, id)
        .then(found => {
          whNames[key] = found || { missing: Date.now() };
          try { localStorage.setItem(NAMES_KEY, JSON.stringify(whNames)); } catch { /* storage unavailable */ }
          if (found) document.querySelectorAll(`#planner [data-wh="${key}"]`).forEach(el => { el.outerHTML = whLinkHTML(kind, id); });
        })
        .catch(() => { /* offline or blocked: keep the ID label and try again next visit */ });
    });
  }

  // Quests and items link to Wowhead, and the video to YouTube, all in a new tab.
  const fmtTime = t => {
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  };
  const videoURL = n => `https://www.youtube.com/watch?v=${encodeURIComponent(n.video)}${n.t ? `&t=${n.t}s` : ''}`;
  function noteLinkHTML(n) {
    const out = [];
    if (n.quest) out.push(whLinkHTML('quest', n.quest, questById.get(+n.quest)?.name));
    for (const i of n.items) out.push(whLinkHTML('item', i));
    if (n.video) out.push(`<a href="${videoURL(n)}" target="_blank" rel="noopener noreferrer" class="note-video">▶ Video${n.t ? ` ${fmtTime(n.t)}` : ''}</a>`);
    for (const u of n.urls) {
      let host = u;
      try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep the full address */ }
      out.push(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${esc(host)} ↗</a>`);
    }
    return out.length ? ` <span class="note-links">${out.join('<span class="dim"> · </span>')}</span>` : '';
  }

  // The note form fields, shared by "Add note" and editing a note in place.
  function noteFieldsHTML(n = {}) {
    const video = n.video ? `${n.video}${n.t ? `?t=${n.t}` : ''}` : '';
    return `
      <input type="number" class="num" data-nf="lv" min="1" max="60" step="1" value="${n.lv ?? ''}" placeholder="Lvl" aria-label="Level">
      <input type="text" data-nf="text" value="${esc(n.text ?? '')}" maxlength="${MAX_TEXT}" placeholder="Note" aria-label="Note">
      <input type="text" data-nf="quest" value="${esc(n.quest ?? '')}" placeholder="Quest ID" aria-label="Quest: Wowhead quest ID or link">
      <input type="text" data-nf="items" value="${esc((n.items || []).join(', '))}" placeholder="Item IDs" aria-label="Items: Wowhead item IDs or links, comma-separated">
      <input type="text" data-nf="video" value="${esc(video)}" placeholder="YouTube ID or link" aria-label="Video: YouTube video ID or link">
      <input type="text" data-nf="urls" value="${esc((n.urls || []).join(', '))}" placeholder="Links" aria-label="Links: web addresses, comma-separated">`;
  }
  const formValues = form => Object.fromEntries(['lv', 'text', 'quest', 'items', 'video', 'urls'].map(k => [k, form.querySelector(`[data-nf="${k}"]`).value]));

  let editingNote = null;          // id of the note being edited in place

  function renderNotes() {
    const L = myLevel();
    const all = [...plan.notes].sort((a, b) => a.lv - b.lv);
    const list = view.near ? all.filter(n => n.id === editingNote || noteNear(n, L)) : all;
    const empty = all.length
      ? `<li class="dim">No notes at level ${L} or ${L + 1}. Untick “Only show my level (+1)” to see all ${all.length}.</li>`
      : '<li class="dim">No notes yet. Pin a reminder to a level, like a quest chain to start or a class trainer visit.</li>';
    $('#p-notes').innerHTML = list.length ? list.map(n => {
      if (n.id === editingNote) {
        return `
          <li class="note-editing">
            <form class="note-form" data-edit-note="${n.id}" novalidate>
              ${noteFieldsHTML(n)}
              <span class="note-actions">
                <button type="submit" class="wow-btn small">Save</button>
                <button type="button" class="wow-btn small" data-cancel-note>Cancel</button>
              </span>
            </form>
            <p class="form-err" data-nf="err" role="alert"></p>
          </li>`;
      }
      const owners = noteOwners(n);
      return `
        <li${view.fadeFar && !noteNear(n, L) ? ' class="far"' : ''}>
          <span class="note-lv">${n.lv}</span>
          <div class="note-body">
            <div>${esc(n.text)}${noteLinkHTML(n)}</div>
            <div class="dim small">${owners.length ? `During ${owners.map(s => esc(stepName(s))).join(', ')}` : 'Outside your route'}</div>
          </div>
          <button type="button" class="wow-btn small" data-edit="${n.id}">Edit</button>
          <button type="button" class="close-x" data-del-note="${n.id}" aria-label="Remove note">✕</button>
        </li>`;
    }).join('') : empty;
    fillWowheadNames();          // also covers note links in open step details, rendered just before
  }

  function renderSummary() {
    const g = gaps();
    $('#p-summary').innerHTML = g.length
      ? `<p class="pwarn warn">⚠ Nothing planned for ${g.map(([a, b]) => b - a === 1 ? `level ${a}` : `levels ${a}–${b - 1}`).join(', ')}. Shaded on the timeline.</p>`
      : '';
  }

  // ---------- Add forms ----------
  // "Add zone" lists zones plus Custom…; "Add dungeon" lists dungeons and their wings.
  const addForm = kind => document.querySelector(`form[data-add="${kind}"]`);
  const field = (form, f) => form.querySelector(`[data-f="${f}"]`);

  // ---------- Add all dungeons ----------
  const missingDungeons = () => [...DUNGEONS]
    .filter(d => !plan.steps.some(s => s.t === 'dungeon' && s.k === d.key))
    .sort((a, b) => a.min - b.min || a.max - b.max);

  function renderAddAll() {
    const n = missingDungeons().length;
    const btn = $('#p-add-all');
    btn.disabled = !n;
    btn.textContent = n ? `Add all dungeons (${n})` : 'All dungeons added';
  }

  // Themed replacement for confirm(). Resolves true when the player confirms.
  function confirmBox(title, bodyHTML, okLabel) {
    const dlg = $('#confirm');
    dlg.querySelector('h2').textContent = title;
    dlg.querySelector('.confirm-body').innerHTML = bodyHTML;
    dlg.querySelector('.confirm-ok').textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    dlg.querySelector('.confirm-ok').focus();
    return new Promise(resolve => {
      const form = dlg.querySelector('form');
      const finish = ok => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('cancel', onCancel);
        dlg.removeEventListener('close', onClose);
        resolve(ok);
      };
      const onSubmit = e => finish(e.submitter?.value === 'ok');   // Cancel / confirm buttons
      const onCancel = () => finish(false);                         // Escape
      const onClose = () => finish(dlg.returnValue === 'ok');       // anything else that closes it
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('cancel', onCancel);
      dlg.addEventListener('close', onClose);
    });
  }

  $('#p-add-all').addEventListener('click', async () => {
    const missing = missingDungeons();
    if (!missing.length) return;
    const ok = await confirmBox(
      `Add ${missing.length} dungeon${missing.length === 1 ? '' : 's'}?`,
      `<p>Each one goes into your route as a single point at its suggested level:</p>
       <ul>${missing.map(d => `<li>${esc(d.name)} <span class="dim">· level ${suggestedLevel(d)}</span></li>`).join('')}</ul>
       <p class="dim small">Drag a point’s handles to stretch it over the levels you’ll spend there.</p>`,
      'Add dungeons');
    if (!ok) return;
    change(() => missing.forEach(d => plan.steps.push(newStep('dungeon', d.key, null, suggestedLevel(d)))));
    toast(`Added ${missing.length} dungeon${missing.length === 1 ? '' : 's'} to your route`);
  });

  function renderAddSelects() {
    renderAddAll();
    const zones = ZONES.filter(z => z.side === 'C' || z.side === plan.faction).sort((a, b) => a.min - b.min || a.name.localeCompare(b.name));
    const dungeons = [...DUNGEONS].sort((a, b) => a.min - b.min || a.max - b.max);
    fillSelect(addForm('zone'), zones.map(z => `<option value="zone:${z.key}">${esc(z.name)} (${z.min}–${z.max})</option>`).join('')
      + '<option value="custom">Custom…</option>');
    fillSelect(addForm('dungeon'), dungeons.map(d => (d.wings
      ? d.wings.map(w => `<option value="dungeon:${d.key}:${esc(w.name)}">${esc(d.name)} · ${esc(w.name)} (${w.min}–${w.max})</option>`).join('')
      : `<option value="dungeon:${d.key}">${esc(d.name)} (${d.min}–${d.max})</option>`)).join(''));
  }
  function fillSelect(form, html) {
    const sel = field(form, 'pick');
    const prev = sel.value;
    sel.innerHTML = html;
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    else prefillAdd(form);
  }

  // Min and max start out as the zone's level range, or a single point at a dungeon's suggested
  // level; custom steps start at the end of the route.
  function prefillAdd(form) {
    const [t, k, wing] = field(form, 'pick').value.split(':');
    let min, max;
    if (t === 'zone') ({ min, max } = zoneByKey[k]);
    else if (t === 'dungeon') {
      const d = byKey[k];
      const w = wing && d.wings?.find(x => x.name === wing);
      min = max = w ? Math.min(w.max, w.min + 2) : suggestedLevel(d);
    } else { min = routeEnd(); max = Math.min(60, min + 1); }
    field(form, 'min').value = min;
    field(form, 'max').value = max;
    const name = field(form, 'name');
    if (name) name.hidden = t !== 'custom';
    field(form, 'err').textContent = '';
  }

  function syncSettings() {
    document.querySelectorAll('#p-faction button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === plan.faction)));
    $('#p-cls').value = plan.cls;
    $('#p-start').value = plan.start;
    $('#p-level').value = myLevel();
    $('#p-level-out').textContent = myLevel();
    $('#p-near').checked = view.near;
    $('#p-fade-far').checked = view.fadeFar;
  }

  function render() {
    const L = myLevel();
    const notesFor = {};
    for (const n of plan.notes) for (const s of noteOwners(n)) (notesFor[s.id] ||= []).push(n);
    // Step numbers stay the same whether or not other steps are hidden.
    const rows = plan.steps.map((s, i) => {
      const near = stepNear(s, L);
      if (view.near && !near && !open.has(s.id)) return '';
      return stepRow(s, i, (notesFor[s.id] || []).sort((a, b) => a.lv - b.lv), view.fadeFar && !near);
    }).filter(Boolean);
    const empty = plan.steps.length
      ? `<div class="no-results">Nothing in your route at level ${L} or ${L + 1}. Untick “Only show my level (+1)” to see all ${plan.steps.length} steps.</div>`
      : '<div class="no-results">No steps yet. Add a zone, dungeon or custom step below, or load the example route.</div>';
    const y = scrollY;
    $('#route-timeline').innerHTML = gridHTML(L) + axisHTML() + (rows.length ? rows.join('') : empty);
    scrollTo(0, y);
    renderSummary();
    renderNotes();
    renderAddSelects();
    syncSettings();
  }

  // ---------- Editing ----------
  function change(fn) {
    fn();
    sortSteps(plan);
    save();
    render();
  }

  const stepById = id => plan.steps.find(s => s.id === id);

  function newStep(t, k, wing, from, end = from) {
    if (t === 'zone') return { id: uid(), t, k, from, end };
    return { id: uid(), t, k, wing: wing || undefined, from, end, pick: {} };
  }

  document.querySelectorAll('form[data-add]').forEach(form => {
    field(form, 'pick').addEventListener('change', () => prefillAdd(form));
    form.addEventListener('input', () => { field(form, 'err').textContent = ''; });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const err = field(form, 'err');
      err.textContent = '';
      const [t, k, wing] = field(form, 'pick').value.split(':');
      const minRaw = field(form, 'min').value.trim(), maxRaw = field(form, 'max').value.trim();
      const min = Math.round(Number(minRaw)), max = Math.round(Number(maxRaw));
      const name = field(form, 'name')?.value.trim() || '';
      if (t === 'custom' && !name) { err.textContent = 'Enter a name for the custom step.'; return; }
      if (!minRaw || !(min >= 1 && min <= 60)) { err.textContent = 'Enter a min level from 1 to 60.'; return; }
      if (!maxRaw || !(max >= 1 && max <= 60)) { err.textContent = 'Enter a max level from 1 to 60.'; return; }
      if (max < min) { err.textContent = 'The max level can’t be below the min level.'; return; }
      const step = t === 'custom'
        ? { id: uid(), t, name: name.slice(0, 60), from: min, end: max }
        : newStep(t, k, wing, min, max);
      change(() => plan.steps.push(step));
      if (field(form, 'name')) field(form, 'name').value = '';
      document.querySelector(`.pstep[data-sid="${step.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });

  document.addEventListener('click', e => {
    // Quest links in the planner open the quest on the timeline: switch tabs before app.js scrolls to it.
    if (e.target.closest('#planner [data-goto]')) showTab('timeline');
  }, true);

  $('#planner').addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    if (e.target.closest('[data-way], [data-ref], [data-goto], a[href^="http"], input, select, label')) return;
    const ins = e.target.closest('[data-insert]');
    if (ins) {
      const zone = stepById(ins.closest('[data-sid]').dataset.sid);
      const d = byKey[ins.dataset.insert];
      change(() => plan.steps.push(newStep('dungeon', d.key, null, Math.max(zone.from, Math.min(zone.end, suggestedLevel(d))))));
      return;
    }
    const del = e.target.closest('[data-del-note]');
    if (del) { change(() => { plan.notes = plan.notes.filter(n => n.id !== del.dataset.delNote); }); return; }
    const edit = e.target.closest('[data-edit]');
    if (edit) { startEditNote(edit.dataset.edit); return; }
    if (e.target.closest('[data-cancel-note]')) { editingNote = null; renderNotes(); return; }
    if (e.target.closest('[data-remove]')) {
      const id = e.target.closest('[data-sid]').dataset.sid;
      open.delete(id);
      change(() => { plan.steps = plan.steps.filter(s => s.id !== id); });
      return;
    }
    const tog = e.target.closest('[data-pstep]');
    if (tog) {
      const id = tog.dataset.pstep;
      open.has(id) ? open.delete(id) : open.add(id);
      render();
    }
  });

  $('#planner').addEventListener('change', e => {
    const lv = e.target.closest('[data-from], [data-end]');
    if (lv) {
      const s = stepById(lv.dataset.from || lv.dataset.end);
      if (!s || lv.value === '') { render(); return; }
      change(() => {
        const v = clampInt(lv.value, 1, 60, 1);
        // Keep from <= end by moving the other side along.
        if (lv.dataset.from) { s.from = v; s.end = Math.max(s.end, v); }
        else { s.end = v; s.from = Math.min(s.from, v); }
      });
      return;
    }
    const take = e.target.closest('[data-take]');
    if (take) {
      const s = stepById(take.closest('[data-sid]').dataset.sid);
      const q = questById.get(+take.dataset.take);
      change(() => {
        s.pick ||= {};
        if (take.checked === defaultTake(q)) delete s.pick[q.id];
        else s.pick[q.id] = take.checked;
      });
      return;
    }
    const wing = e.target.closest('[data-wing]');
    if (wing) {
      const s = stepById(wing.closest('[data-sid]').dataset.sid);
      change(() => { s.wing = wing.value || undefined; });
    }
  });
  // Enter in a level box applies it right away.
  $('#planner').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('[data-from], [data-end]')) e.target.blur();
  });

  // ---------- Dragging ----------
  // Handles change one end; dragging the bar itself moves the whole step. Levels snap to whole numbers.
  // A press on the bar that doesn't move is left to the click handler, which opens the step.
  let drag = null;
  let suppressClick = false;

  $('#route-timeline').addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-drag]');
    if (!h || e.button !== 0) return;
    const row = h.closest('[data-sid]');
    const s = stepById(row.dataset.sid);
    const track = row.querySelector('.track');
    drag = { s, mode: h.dataset.drag, x: e.clientX, from: s.from, end: s.end, w: track.getBoundingClientRect().width, row, moved: false };
    try { h.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (drag.mode !== 'move') e.preventDefault();
  });

  $('#route-timeline').addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    const dl = Math.round((dx / drag.w) * (AMAX - AMIN));
    let { from, end } = drag;
    if (drag.mode === 'from') from = Math.max(1, Math.min(end, from + dl));
    else if (drag.mode === 'end') end = Math.min(60, Math.max(from, end + dl));
    else {
      const shift = Math.max(1 - from, Math.min(60 - end, dl));
      from += shift; end += shift;
    }
    drag.next = { from, end };
    // Update the row in place while dragging; a full render happens on release.
    const g = barGeometry(from, end);
    const bar = drag.row.querySelector('.pbar');
    bar.style.cssText = g.bar;
    bar.classList.toggle('point', from === end);
    bar.textContent = from === end ? '' : `${from}–${end}`;
    drag.row.querySelector('.ph.l').style.cssText = g.hl;
    drag.row.querySelector('.ph.r').style.cssText = g.hr;
    drag.row.querySelector('[data-from]').value = from;
    drag.row.querySelector('[data-end]').value = end;
    drag.row.classList.add('dragging');
    T.hideTip?.();
  });

  function endDrag() {
    if (!drag) return;
    const { s, moved, next } = drag;
    drag = null;
    if (!moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (next) change(() => { s.from = next.from; s.end = next.end; });
    else render();
  }
  $('#route-timeline').addEventListener('pointerup', endDrag);
  $('#route-timeline').addEventListener('pointercancel', endDrag);

  // ---------- Route controls ----------

  $('#p-faction').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) change(() => { plan.faction = b.dataset.value; });
  });
  $('#p-cls').addEventListener('change', e => change(() => { plan.cls = e.target.value; }));
  $('#p-start').addEventListener('change', e => change(() => { plan.start = clampInt(e.target.value, 1, 59, plan.start); }));

  // Level slider and filters (see "Level filter").
  let levelRaf = 0;
  $('#p-level').addEventListener('input', e => {
    const L = clampInt(e.target.value, 1, 60, myLevel());
    $('#p-level-out').textContent = L;
    T.setLevel?.(L);
    cancelAnimationFrame(levelRaf);
    levelRaf = requestAnimationFrame(render);
  });
  $('#p-near').addEventListener('change', e => {
    view.near = e.target.checked;
    if (view.near) view.fadeFar = false;
    saveView(); render();
  });
  $('#p-fade-far').addEventListener('change', e => {
    view.fadeFar = e.target.checked;
    if (view.fadeFar) view.near = false;
    saveView(); render();
  });

  $('#p-example').addEventListener('click', () => {
    if ((plan.steps.length || plan.notes.length) && !confirm('Replace your current route with the example?')) return;
    open.clear();
    plan = clean(EXAMPLE);
    save();
    render();
  });
  $('#p-clear').addEventListener('click', () => {
    if (!plan.steps.length && !plan.notes.length) return;
    if (!confirm('Clear every step and note in your route?')) return;
    open.clear();
    change(() => { plan.steps = []; plan.notes = []; });
  });
  $('#p-share').addEventListener('click', async () => {
    const link = shareLink();
    try { await navigator.clipboard.writeText(link); toast('Share link copied'); }
    catch { prompt('Copy this link:', link); }
  });

  // Notes
  const noteErr = $('#p-note-err');
  $('#p-note-form').addEventListener('input', () => { noteErr.textContent = ''; });
  $('#p-note-form').addEventListener('submit', e => {
    e.preventDefault();
    noteErr.textContent = '';
    const n = readNote(formValues($('#p-note-form')));
    if (n.error) { noteErr.textContent = n.error; return; }
    change(() => plan.notes.push({ id: uid(), ...n }));
    $('#p-note-form').reset();
  });

  // Editing a note in place: Save applies the changes, Cancel or Escape drops them.
  function startEditNote(id) {
    editingNote = id;
    renderNotes();
    $('#p-notes [data-nf="text"]')?.focus();
  }
  $('#p-notes').addEventListener('submit', e => {
    const form = e.target.closest('[data-edit-note]');
    if (!form) return;
    e.preventDefault();
    const n = readNote(formValues(form));
    if (n.error) { form.parentElement.querySelector('[data-nf="err"]').textContent = n.error; return; }
    const note = plan.notes.find(x => x.id === form.dataset.editNote);
    editingNote = null;
    change(() => Object.assign(note, n));
  });
  $('#p-notes').addEventListener('input', e => {
    const err = e.target.closest('li')?.querySelector('[data-nf="err"]');
    if (err) err.textContent = '';
  });
  $('#p-notes').addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target.closest('[data-edit-note]')) { editingNote = null; renderNotes(); }
  });

  // Quests marked complete on the timeline show as done here too.
  document.addEventListener('forever:done', () => { if (!$('#planner').hidden) render(); });

  // Lets the Timeline tab add a dungeon to the route, or jump to it here.
  window.ForeverPlanner = {
    has: key => plan.steps.some(s => s.t === 'dungeon' && s.k === key),
    add(key) {
      const d = byKey[key];
      if (!d) return;
      const step = newStep('dungeon', key, null, suggestedLevel(d));
      change(() => plan.steps.push(step));
      toast(`Added ${d.name} to your route at level ${step.from}`);
    },
    show(key) {
      const s = plan.steps.find(x => x.t === 'dungeon' && x.k === key);
      if (s) open.add(s.id);
      showTab('planner');
      if (s) document.querySelector(`.pstep[data-sid="${s.id}"]`)?.scrollIntoView({ block: 'center' });
    },
  };

  renderPlanner = render;
  let startTab = 'timeline';
  try { startTab = localStorage.getItem(TAB_KEY) === 'planner' ? 'planner' : 'timeline'; } catch { /* storage unavailable */ }
  if (importFromHash()) startTab = 'planner';
  showTab(startTab);
})();
