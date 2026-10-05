(() => {
  'use strict';

  const LMIN = 10;
  const LMAX = 60;
  const CELLS = LMAX - LMIN + 1;           // level L occupies the cell [L, L+1)
  const STORE_KEY = 'forever-timeline-v1';
  const WOWHEAD = 'https://www.wowhead.com/forever/';

  const DUNGEONS = window.FOREVER_DUNGEONS || [];
  const RAW = window.FOREVER_QUESTS || { quests: [] };
  const J = window.FOREVER_JOURNAL || { quests: {}, chains: {}, dungeons: {} };
  const byKey = Object.fromEntries(DUNGEONS.map(d => [d.key, d]));

  // Classic uiMapIDs used by the DungeonJournal addon.
  const ZONES = {
    1411: 'Durotar', 1412: 'Mulgore', 1413: 'The Barrens', 1414: 'Kalimdor', 1415: 'Eastern Kingdoms',
    1416: 'Alterac Mountains', 1417: 'Arathi Highlands', 1418: 'Badlands', 1419: 'Blasted Lands',
    1420: 'Tirisfal Glades', 1421: 'Silverpine Forest', 1422: 'Western Plaguelands', 1423: 'Eastern Plaguelands',
    1424: 'Hillsbrad Foothills', 1425: 'The Hinterlands', 1426: 'Dun Morogh', 1427: 'Searing Gorge',
    1428: 'Burning Steppes', 1429: 'Elwynn Forest', 1430: 'Deadwind Pass', 1431: 'Duskwood', 1432: 'Loch Modan',
    1433: 'Redridge Mountains', 1434: 'Stranglethorn Vale', 1435: 'Swamp of Sorrows', 1436: 'Westfall',
    1437: 'Wetlands', 1438: 'Teldrassil', 1439: 'Darkshore', 1440: 'Ashenvale', 1441: 'Thousand Needles',
    1442: 'Stonetalon Mountains', 1443: 'Desolace', 1444: 'Feralas', 1445: 'Dustwallow Marsh', 1446: 'Tanaris',
    1447: 'Azshara', 1448: 'Felwood', 1449: "Un'Goro Crater", 1450: 'Moonglade', 1451: 'Silithus',
    1452: 'Winterspring', 1453: 'Stormwind City', 1454: 'Orgrimmar', 1455: 'Ironforge', 1456: 'Thunder Bluff',
    1457: 'Darnassus', 1458: 'Undercity',
  };
  const QUALITY = ['q-poor', 'q-common', 'q-uncommon', 'q-rare', 'q-epic', 'q-legendary'];

  // Classic quest colours from quest level + required level, for quests Wowhead hasn't covered.
  // Grey once the player outlevels the quest by 5 + floor(playerLevel / 10).
  function estimateColours(level, req) {
    let grey = level + 1;
    while (grey - (5 + Math.floor(grey / 10)) < level) grey++;
    const orange = Math.max(req, level - 4);
    return { red: req, orange, yellow: Math.max(req, level - 2), green: level + 3, grey };
  }

  // Wowhead guide quests, plus dungeon quests only the addon knows about.
  const known = new Set(RAW.quests.map(q => q.id));
  const SIDE_OF = { Alliance: 'A', Horde: 'H', Both: 'B' };
  const extra = Object.values(J.quests)
    .filter(a => a.dungeon && a.name && a.level && !known.has(a.id) && byKey[a.dungeon])
    .map(a => ({
      id: a.id, name: a.name, d: a.dungeon, side: SIDE_OF[a.faction] || 'B', share: null,
      req: a.requires ?? a.level, level: a.level, ...estimateColours(a.level, a.requires ?? a.level),
      starts: a.pickup, estimated: true, classes: a.classOnly ? [a.classOnly] : undefined,
    }));

  // Normalise quests: `from` = first level the quest is not red, `to` = level it turns grey.
  const QUESTS = [...RAW.quests, ...extra].map((q, i) => ({
    ...q,
    idx: i,
    from: q.orange ?? q.yellow ?? q.green ?? q.req,
    to: q.grey ?? (q.level + 6),
  }));
  const questById = new Map(QUESTS.map(q => [q.id, q]));

  // ---------- State ----------
  // Every setting is remembered in this browser between visits.
  const defaults = { level: 15, faction: 'all', type: 'all', cls: '', share: false, near: true, fadeFar: false, hideDone: false, search: '', collapsed: [], done: [] };
  const state = { ...defaults, ...load() };
  state.q = state.search.trim().toLowerCase();   // normalised search, derived from `search`
  const collapsed = new Set(state.collapsed);
  const done = new Set(state.done);               // completed quest (and chain step) IDs
  const open = new Set();                         // quests whose detail drawer is open
  let focus = null;                               // dungeon key highlighted in the quest timeline

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
      return Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in defaults && typeof v === typeof defaults[k]));
    } catch { return {}; }
  }
  function save() {
    try {
      const { q, collapsed: _c, done: _d, ...rest } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...rest, collapsed: [...collapsed], done: [...done] }));
    } catch { /* storage unavailable */ }
  }

  // ---------- Helpers ----------
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pct = L => ((clamp(L, LMIN, LMAX + 1) - LMIN) / CELLS) * 100;
  const fmt = n => (Math.round(n * 10) / 10).toFixed(1);

  function barStyle(from, toExcl) {
    const left = pct(from);
    const width = Math.max(pct(toExcl) - left, 0.6);
    return `left:${left}%;width:${width}%`;
  }

  function diffAt(q, L) {
    if (L < q.from) return 'red';
    if (q.yellow != null && L < q.yellow) return 'orange';
    if (q.green != null && L < q.green) return 'yellow';
    if (L < q.to) return 'green';
    return 'grey';
  }

  const SIDE = { A: ['fac-a', 'A', 'Alliance'], H: ['fac-h', 'H', 'Horde'], B: ['fac-b', 'N', 'Alliance & Horde'] };
  const FLAG = { pre: ['Pre', 'Has prerequisite quests'], drop: ['Drop', 'Starts from a dropped item'], escort: ['Esc', 'Escort quest'], object: ['Obj', 'Starts from an object'], tbd: ['TBD', 'Details still being confirmed'], repeatable: ['Rep', 'Repeatable'] };

  // ---------- Locations ----------
  // Map point from the addon ({mapID, x, y} in 0-100) or Wowhead ({zone, x, y}).
  function pointFrom(p) {
    if (!p) return null;
    const zone = p.zone || ZONES[p.mapID];
    return zone && p.x != null ? { zone, x: p.x, y: p.y, label: p.label } : null;
  }

  // Where to pick a quest up: town/subzone text plus coordinates.
  // Text comes from the Wowhead guide ("Orgrimmar, The Drag - Neeru Fireblade /way 49 50")
  // or the addon's pickup note; coordinates prefer the addon, then Wowhead's map data,
  // then the guide's /way.
  function questLocation(id) {
    const q = questById.get(id);
    const a = J.quests[id];
    let place = null, npc = q?.start || null;
    const guide = q?.starts || '';
    const m = guide.match(/^(.+?)\s*-\s+(.+?)(?:\s*\/(?:way)?\s*[\d.]+[ ,]+[\d.]+.*)?$/);
    if (m && !/^(inside|the hall of thanes|.*(deeps|downs|kraul|keep|chasm|caverns),)/i.test(m[1])) {
      place = m[1].replace(/\s*,\s*/g, ', ').trim();
      npc = npc || m[2].replace(/\s*\/.*$/, '').trim();
    }
    let pt = pointFrom(a?.startMap) || pointFrom(q?.startAt);
    if (!pt) {
      const w = guide.match(/\/(?:way\s*)?([\d.]+)[ ,]+([\d.]+)/);
      const zone = place ? place.split(',')[0] : null;
      if (w && zone) pt = { zone, x: +w[1], y: +w[2] };
    }
    if (!place && a?.pickup && !/inside|dungeon|drop|item/i.test(a.pickup)) {
      const parts = a.pickup.split(',').map(s => s.trim());
      if (parts.length > 1) { npc = npc || parts[0]; place = parts.slice(1).join(', '); }
    }
    if (!place && pt) place = pt.zone;
    if (!place && !pt) {
      const text = guide + ' ' + (a?.pickup || '');
      if (/inside|dungeon|interact|vault/i.test(text)) return { place: 'Inside the dungeon', inside: true, npc };
      if (/drop|item/i.test(text)) return { place: 'Starts from an item', inside: true, npc };
      return null;
    }
    return { place, pt, npc };
  }

  const wayCmd = pt => `/way ${pt.zone} ${fmt(pt.x)} ${fmt(pt.y)}`;
  function locHTML(loc, cls = '') {
    if (!loc) return '';
    const coords = loc.pt ? ` <span class="coords">${fmt(loc.pt.x)}, ${fmt(loc.pt.y)}</span>` : '';
    const title = loc.pt ? `Copy ${wayCmd(loc.pt)}` : '';
    return loc.pt
      ? `<button type="button" class="loc ${cls}" data-way="${esc(wayCmd(loc.pt))}" title="${esc(title)}">${esc(loc.place)}${coords}</button>`
      : `<span class="loc ${cls}${loc.inside ? ' inside' : ''}">${esc(loc.place)}</span>`;
  }

  // ---------- Chains ----------
  // Required chains come from DungeonJournal (curated, no optional breadcrumbs).
  // Otherwise Wowhead's quest series is used, which can include optional steps.
  function chainFor(q) {
    const series = (q.series || []).find(s => s.some(x => x.id === q.id)) || [];
    const at = series.findIndex(x => x.id === q.id);
    const after = at >= 0 ? series.slice(at + 1) : [];
    const req = J.chains[q.id];
    if (req?.length) {
      return { kind: 'required', steps: [...req.map(s => ({ ...s })), { id: q.id, name: q.name, self: true }], after };
    }
    if (series.length < 2) return null;
    return {
      kind: 'storyline',
      steps: series.slice(0, at + 1).map(s => ({ ...s, self: s.id === q.id })),
      after,
    };
  }
  function chainProgress(chain) {
    const n = chain.steps.filter(s => done.has(s.id)).length;
    return { n, total: chain.steps.length, next: chain.steps.find(s => !done.has(s.id)) };
  }

  // ---------- Filters ----------
  // "Near" = doable at your level, or becomes doable at the next level.
  const questNear = q => q.from <= state.level + 1 && q.to > state.level;
  const rangeNear = (min, max) => min <= state.level + 1 && max >= state.level;
  const dungeonRanges = d => d.wings || [d];

  function questVisible(q) {
    const d = byKey[q.d];
    if (state.type !== 'all' && d && d.type !== state.type) return false;
    if (state.faction !== 'all' && q.side !== 'B' && q.side !== state.faction) return false;
    if (state.share && !q.share) return false;
    if (state.near && !questNear(q)) return false;
    if (state.hideDone && done.has(q.id)) return false;
    if (state.cls === 'none' && (q.classes || q.profession)) return false;
    if (state.cls && state.cls !== 'none' && q.classes && !q.classes.includes(state.cls)) return false;
    if (state.q) {
      const loc = questLocation(q.id);
      const hay = `${q.name} ${d ? d.name + ' ' + d.zone : ''} ${q.start || ''} ${q.starts || ''} ${q.wing || ''} ${loc?.place || ''}`.toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  }

  function dungeonVisible(d) {
    if (state.type !== 'all' && d.type !== state.type) return false;
    if (state.q) {
      const hay = `${d.name} ${d.zone}`.toLowerCase();
      if (!hay.includes(state.q) && !QUESTS.some(q => q.d === d.key && questVisible(q))) return false;
    }
    return true;
  }

  // ---------- Shared timeline chrome ----------
  function gridHTML() {
    let h = '<div class="grid" aria-hidden="true">';
    for (let L = LMIN; L <= LMAX + 1; L++) {
      h += `<i class="gl${L % 5 === 0 ? ' major' : ''}" style="left:${pct(L)}%"></i>`;
    }
    h += '</div><div class="grid top" aria-hidden="true"><i class="you"></i></div>';
    return h;
  }

  function axisHTML(title) {
    let ticks = '';
    for (let L = LMIN; L <= LMAX; L++) {
      const center = pct(L) + 50 / CELLS;
      ticks += L % 5 === 0 || L === LMIN
        ? `<span class="tick" style="left:${center}%">${L}</span>`
        : `<span class="tick minor" style="left:${pct(L)}%"></span>`;
    }
    return `<div class="row axis"><div class="label">${esc(title)}</div><div class="track">${ticks}</div></div>`;
  }

  function placeYou() {
    const x = pct(state.level) + 50 / CELLS;
    document.querySelectorAll('.timeline:not(#route-timeline) .grid .you').forEach(el => {   // the planner places its own
      el.style.left = `${x}%`;
      el.hidden = state.level < LMIN;
    });
  }

  // "Add to planner" for a dungeon, or "View in planner" once it's in the route (js/planner.js).
  // On small screens only the icon shows.
  const planLabel = key => (window.ForeverPlanner?.has(key)
    ? '↗<span class="pl-text"> View in planner</span>' : '＋<span class="pl-text"> Add to planner</span>');
  const planTitle = key => (window.ForeverPlanner?.has(key) ? 'View in planner' : 'Add to planner');
  const planBtn = (key, cls = '') => window.ForeverPlanner
    ? `<button type="button" class="wow-btn small ${cls}" data-plan="${key}" title="${planTitle(key)}" aria-label="${planTitle(key)}">${planLabel(key)}</button>` : '';

  const bookBtn = key => `<button type="button" class="book" data-ref="${key}" title="Quick reference" aria-label="Quick reference: ${esc(byKey[key]?.name)}">📖</button>`;

  // ---------- Dungeon timeline ----------
  function renderDungeons() {
    const rows = [];
    const list = DUNGEONS.filter(dungeonVisible)
      .flatMap(d => (d.wings || [null]).map(w => ({ d, w })))
      .filter(({ d, w }) => !state.near || rangeNear((w || d).min, (w || d).max))
      .sort((a, b) => (a.w?.min ?? a.d.min) - (b.w?.min ?? b.d.min) || (a.w?.max ?? a.d.max) - (b.w?.max ?? b.d.max));

    for (const { d, w } of list) {
      const min = w ? w.min : d.min;
      const max = w ? w.max : d.max;
      const inRange = state.level >= min && state.level <= max;
      const far = state.fadeFar && !rangeNear(min, max);
      rows.push(`
        <div class="row d${inRange ? ' in-range' : ''}${far ? ' far' : ''}${focus === d.key ? ' selected' : ''}" data-d="${d.key}">
          <div class="label">
            ${bookBtn(d.key)}
            <a class="name" href="#g-${d.key}" data-jump="${d.key}">${esc(d.name)}${w ? ` <span class="wing-name">· ${esc(w.name)}</span>` : ''}</a>
            ${d.type === 'new' ? '<span class="new-tag">New</span>' : ''}
            <span class="spacer"></span>
            <span class="zone">${esc(d.zone)}</span>
          </div>
          <div class="track">
            <span class="bar dungeon${d.type === 'new' ? ' is-new' : ''}" style="${barStyle(min, max + 1)}"
              tabindex="0" data-tip="d:${d.key}${w ? ':' + esc(w.name) : ''}">${min}–${max}</span>
          </div>
        </div>`);
    }
    $('#dungeon-timeline').innerHTML = gridHTML() + axisHTML('Dungeon') +
      (rows.length ? rows.join('') : '<div class="no-results">No dungeons match.</div>');
  }

  // ---------- Quest timeline ----------
  function chainBadge(q, chain) {
    if (!chain) return '';
    const { n, total } = chainProgress(chain);
    const label = chain.kind === 'required' ? 'Required quest chain' : 'Storyline (Wowhead)';
    return `<span class="chain-badge${n === total ? ' complete' : ''}${chain.kind === 'storyline' ? ' storyline' : ''}" title="${label}: ${n} of ${total} done">⛓ ${n}/${total}</span>`;
  }

  function questRow(q) {
    const [fc, fl, ft] = SIDE[q.side] || SIDE.B;
    const diff = diffAt(q, state.level);
    const chain = chainFor(q);
    const tags = (q.flags || []).filter(f => !(chain && f === 'pre'))
      .map(f => FLAG[f] ? `<span class="tag" title="${FLAG[f][1]}">${FLAG[f][0]}</span>` : '').join('');
    const cls = (q.classes || []).map(c => `<span class="tag tag-class c-${esc(c)}" title="${esc(c)} only">${esc(c)}</span>`).join('');
    const prof = q.profession ? `<span class="tag tag-class c-prof" title="${esc(q.profession)} only">${esc(q.profession)}</span>` : '';
    const share = q.share == null
      ? '<span class="ico ico-unknown" title="Shareability unknown">?</span>'
      : q.share ? '<span class="ico ico-share" title="Shareable">⇄</span>'
                : '<span class="ico ico-noshare" title="Not shareable">⇄</span>';
    const runsOn = q.to > LMAX + 1;
    const notches = [q.yellow, q.green]
      .filter(v => v != null && v > q.from && v < Math.min(q.to, LMAX + 1))
      .map(v => `<i class="notch" style="left:${((v - q.from) / (Math.min(q.to, LMAX + 1) - q.from)) * 100}%"></i>`).join('');
    const doable = state.level >= q.from && state.level < q.to;
    const isDone = done.has(q.id);
    const isOpen = open.has(q.id);
    return `
      <div class="row q${doable ? '' : ' dim'}${state.fadeFar && !questNear(q) ? ' far' : ''}${isDone ? ' done' : ''}${isOpen ? ' open' : ''}" data-q="${q.id}">
        <div class="label">
          <span class="fac ${fc}" title="${ft}">${fl}</span>
          <a class="name d-${diff}" href="#q-${q.id}" data-open="${q.id}" data-tip="q:${q.idx}" aria-expanded="${isOpen}">${isDone ? '<span class="done-mark" aria-label="Completed">✓</span>' : ''}${esc(q.name)}</a>
          ${cls}${prof}${chainBadge(q, chain)}${tags}${share}
          <span class="spacer"></span>
          ${locHTML(questLocation(q.id), 'row-loc')}
        </div>
        <div class="track">
          <span class="bar quest${runsOn ? ' runs-on' : ''}${q.estimated ? ' estimated' : ''}" style="${barStyle(q.from, q.to)}" tabindex="0" data-tip="q:${q.idx}">${notches}${q.from}–${q.to}</span>
        </div>
      </div>
      ${isOpen ? drawerHTML(q, chain) : ''}`;
  }

  function stepHTML(s, nextId) {
    const sq = questById.get(s.id);
    const a = J.quests[s.id];
    const loc = s.map ? { place: s.map.label || ZONES[s.map.mapID], pt: pointFrom(s.map) } : questLocation(s.id);
    const lvl = s.level ?? sq?.level ?? a?.level;
    const req = s.requires ?? sq?.req ?? a?.requires;
    const objective = s.objective || a?.objective;
    const pickup = s.pickup || a?.pickup;
    const isDone = done.has(s.id);
    const name = s.itemStep
      ? `<span class="step-name">${esc(s.name)}</span>`
      : `<a class="step-name" href="${WOWHEAD}quest=${s.id}" target="_blank" rel="noopener">${esc(s.name)}</a>`;
    return `
      <li class="step${isDone ? ' done' : ''}${s.self ? ' self' : ''}">
        <label class="check"><input type="checkbox" data-done="${s.id}"${isDone ? ' checked' : ''}><span class="sr">Completed</span></label>
        <div class="step-body">
          <div class="step-head">
            ${name}
            ${s.self ? '<span class="tag tag-self">This quest</span>' : ''}
            ${s.itemStep ? '<span class="tag">Item step</span>' : ''}
            ${!isDone && s.id === nextId ? '<span class="tag tag-next">Next</span>' : ''}
            ${lvl ? `<span class="step-lvl">Lv ${lvl}${req ? ` · req ${req}` : ''}</span>` : ''}
          </div>
          ${pickup && !s.self ? `<div class="step-line"><b>Start:</b> ${esc(pickup)}</div>` : ''}
          ${loc && !s.self ? `<div class="step-line">${locHTML(loc)}</div>` : ''}
          ${objective && !s.self ? `<div class="step-line dim">${esc(objective)}</div>` : ''}
          ${s.note ? `<div class="step-line note">${esc(s.note)}</div>` : ''}
        </div>
      </li>`;
  }

  function drawerHTML(q, chain) {
    const a = J.quests[q.id] || {};
    const loc = questLocation(q.id);
    const prog = chain && chainProgress(chain);
    const isDone = done.has(q.id);
    return `
      <div class="row drawer" data-drawer="${q.id}">
        <div class="drawer-body">
          <div class="drawer-head">
            <label class="check big"><input type="checkbox" data-done="${q.id}"${isDone ? ' checked' : ''}> <span>${isDone ? 'Completed' : 'Mark complete'}</span></label>
            <a class="wow-btn small" href="${WOWHEAD}quest=${q.id}" target="_blank" rel="noopener">Wowhead ↗</a>
            <button type="button" class="wow-btn small" data-ref="${q.d}">📖 ${esc(byKey[q.d]?.name || 'Dungeon')}</button>
            <button type="button" class="close-x" data-open="${q.id}" aria-label="Close details">✕</button>
          </div>
          <div class="drawer-grid">
            <div>
              <h4>Pick up</h4>
              <p>${esc(loc?.npc || q.start || '')}${loc ? ` — ${locHTML(loc)}` : ''}</p>
              ${a.pickup ? `<p class="dim">${esc(a.pickup)}</p>` : q.starts ? `<p class="dim">${esc(q.starts)}</p>` : ''}
              ${a.objective ? `<h4>Objective</h4><p>${esc(a.objective)}</p>` : ''}
              ${a.turnin ? `<h4>Turn in</h4><p>${esc(a.turnin)}</p>` : ''}
              ${a.note ? `<p class="note">${esc(a.note)}</p>` : ''}
              ${a.rewards ? `<h4>Rewards</h4><p class="pre">${esc(a.rewards)}</p>` : ''}
              ${q.estimated ? '<p class="dim">Difficulty colours are estimated from the quest level (not yet on Wowhead).</p>' : ''}
            </div>
            ${chain ? `
            <div>
              <h4>${chain.kind === 'required' ? 'Required quest chain' : 'Storyline'} <span class="dim">· ${prog.n}/${prog.total} done</span></h4>
              ${chain.kind === 'storyline' ? '<p class="dim small">From Wowhead’s quest series — may include optional breadcrumb steps.</p>' : '<p class="dim small">Every step is required to unlock this quest.</p>'}
              <ol class="chain">${chain.steps.map(s => stepHTML(s, prog.next?.id)).join('')}</ol>
              ${chain.after.length ? `<h4>Continues with</h4><ol class="chain after">${chain.after.map(s => stepHTML(s, null)).join('')}</ol>` : ''}
            </div>` : ''}
          </div>
        </div>
      </div>`;
  }

  function renderQuests() {
    const out = [];
    let shown = 0;
    const filtering = state.faction !== 'all' || state.share || state.cls || state.q || state.hideDone;

    const groups = [...DUNGEONS].sort((a, b) => a.min - b.min || a.max - b.max);
    for (const d of groups) {
      if (!dungeonVisible(d)) continue;
      const all = QUESTS.filter(q => q.d === d.key);
      const vis = all.filter(questVisible).sort((a, b) => a.from - b.from || a.to - b.to || a.name.localeCompare(b.name));
      if (all.length && !vis.length) continue;
      if (!all.length && (filtering || (state.near && !dungeonRanges(d).some(w => rangeNear(w.min, w.max))))) continue;
      shown += vis.length;

      const isCollapsed = collapsed.has(d.key);
      const ranges = (d.wings || [d]).map(w =>
        `<span class="bar dungeon ghost" style="${barStyle(w.min, w.max + 1)}"></span>`).join('');
      const g = [];
      out.push(`<div class="qgroup${focus === d.key ? ' focus' : ''}" data-d="${d.key}">`, g, '</div>');
      const doneCount = all.filter(q => done.has(q.id)).length;
      const groupFar = state.fadeFar && !dungeonRanges(d).some(w => rangeNear(w.min, w.max)) && !vis.some(questNear);
      g.push(`
        <div class="row group-head${isCollapsed ? ' collapsed' : ''}${groupFar ? ' far' : ''}" id="g-${d.key}">
          <div class="label" role="button" tabindex="0" aria-expanded="${!isCollapsed}" data-toggle="${d.key}">
            <span class="caret">▼</span>
            ${bookBtn(d.key)}
            <span class="name">${esc(d.name)}</span>
            ${d.type === 'new' ? '<span class="new-tag">New</span>' : ''}
            <span class="spacer"></span>
            ${planBtn(d.key, 'plan-btn')}
            ${doneCount ? `<span class="gcount done-count" title="Completed">✓ ${doneCount}</span>` : ''}
            <span class="gcount">${all.length ? (vis.length === all.length ? all.length : `${vis.length}/${all.length}`) : '—'}</span>
          </div>
          <div class="track">${ranges}</div>
        </div>`);
      if (isCollapsed) continue;

      if (!all.length) {
        g.push('<div class="row empty"><div class="label">No quest data yet</div><div class="track"></div></div>');
        continue;
      }
      const wings = [...new Set(vis.map(q => q.wing || ''))];
      for (const wing of wings) {
        if (wings.length > 1 || wing) {
          g.push(`<div class="row wing-head"><div class="label">${esc(wing || 'General')}</div><div class="track"></div></div>`);
        }
        for (const q of vis.filter(q => (q.wing || '') === wing)) g.push(questRow(q));
      }
    }

    $('#quest-timeline').innerHTML = gridHTML() + axisHTML('Quest') +
      (out.length ? out.flat().join('') : '<div class="no-results">No quests match these filters.</div>');
    applyFocus();
    $('#quest-count').textContent = `${shown} of ${QUESTS.length} quests shown`;
  }

  // ---------- Tooltip ----------
  const tip = $('#tip');

  function questTip(q) {
    const d = byKey[q.d];
    const diff = diffAt(q, state.level);
    const side = { A: '<span class="t-alliance">Alliance</span>', H: '<span class="t-horde">Horde</span>', B: 'Alliance &amp; Horde' }[q.side];
    const steps = [
      q.red != null && q.from > q.red ? ['d-red', 'Red', `≤${q.from - 1}`] : null,
      q.orange != null ? ['d-orange', 'Orange', q.orange] : null,
      q.yellow != null ? ['d-yellow', 'Yellow', q.yellow] : null,
      q.green != null ? ['d-green', 'Green', q.green] : null,
      q.grey != null ? ['d-grey', 'Grey', q.grey] : null,
    ].filter(Boolean);
    const flags = (q.flags || []).map(f => FLAG[f]?.[1]).filter(Boolean);
    if (q.classes) flags.unshift(`${q.classes.join(' / ')} only`);
    if (q.profession) flags.unshift(`${q.profession} only`);
    if (q.races) flags.push(`Races: ${q.races.join(', ')}`);
    const loc = questLocation(q.id);
    const chain = chainFor(q);
    const prog = chain && chainProgress(chain);
    const share = q.share == null ? '<div class="t-dim">Shareability unknown</div>'
      : `<div class="${q.share ? 't-green' : 't-red'}">${q.share ? 'Shareable' : 'Not shareable'}</div>`;
    return `
      <div class="t-title d-${diff}">${done.has(q.id) ? '✓ ' : ''}${esc(q.name)}</div>
      ${loc ? `<div class="t-loc">📍 ${esc(loc.place)}${loc.pt ? ` <b>${fmt(loc.pt.x)}, ${fmt(loc.pt.y)}</b>` : ''}</div>` : ''}
      ${loc?.npc ? `<div class="t-dim">${esc(loc.npc)}</div>` : ''}
      <div class="t-gold">${esc(d ? d.name : '')}${q.wing ? ` · ${esc(q.wing)}` : ''}</div>
      <div>Level ${q.level} · Requires level ${q.req}</div>
      <div>${side}</div>
      ${share}
      <div class="t-diff">${steps.map(([c, n, v]) => `<span class="${c}">${v}<small>${n}</small></span>`).join('')}</div>
      ${chain ? `<div class="t-sep"></div><div class="t-chain">⛓ ${chain.kind === 'required' ? 'Required chain' : 'Storyline'}: ${prog.n}/${prog.total} done${prog.next && !prog.next.self ? ` · next: <b>${esc(prog.next.name)}</b>` : ''}</div>` : ''}
      ${flags.length ? `<div class="t-note">${flags.map(esc).join(' · ')}</div>` : ''}
      <div class="t-dim" style="margin-top:4px">${q.estimated ? 'Estimated: ' : ''}Doable from ${q.from} until it greys out at ${q.to}. Click for details.</div>`;
  }

  function dungeonTip(d, wingName) {
    const w = wingName && d.wings ? d.wings.find(x => x.name === wingName) : null;
    const min = w ? w.min : d.min, max = w ? w.max : d.max;
    const n = QUESTS.filter(q => q.d === d.key).length;
    const g = d.guide;
    return `
      <div class="t-title d-green">${esc(d.name)}${w ? ` — ${esc(w.name)}` : ''}</div>
      <div class="t-gold">${d.type === 'new' ? 'New Forever dungeon' : 'Classic dungeon'}</div>
      <div>Levels ${min}–${max}</div>
      <div class="t-dim">${esc(d.zone)}</div>
      ${d.note ? `<div class="t-note">${esc(d.note)}</div>` : ''}
      ${g ? `<div class="t-sep"></div><div class="t-diff">
        <span class="d-red">${g.hard}<small>Hard</small></span>
        <span class="d-orange">${g.medium}<small>Medium</small></span>
        <span class="d-yellow">${g.at}<small>At level</small></span>
        ${g.easy ? `<span class="d-green">${g.easy}<small>Easy</small></span>` : ''}</div>` : ''}
      <div class="t-dim" style="margin-top:4px">${n ? `${n} dungeon quests` : 'No quest data yet'}</div>`;
  }

  function showTip(el, x, y) {
    const [kind, key, wing] = el.dataset.tip.split(':');
    tip.innerHTML = kind === 'q' ? questTip(QUESTS[+key]) : dungeonTip(byKey[key], wing);
    tip.hidden = false;
    moveTip(x, y);
  }
  function moveTip(x, y) {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let left = x + pad, top = y + pad;
    if (left + r.width > innerWidth - 8) left = Math.max(8, x - r.width - pad);
    if (top + r.height > innerHeight - 8) top = Math.max(8, y - r.height - pad);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() { tip.hidden = true; }

  document.addEventListener('pointerover', e => {
    const el = e.target.closest('[data-tip]');
    if (el && e.pointerType === 'mouse') showTip(el, e.clientX, e.clientY);
  });
  document.addEventListener('pointermove', e => {
    if (!tip.hidden && e.pointerType === 'mouse' && e.target.closest('[data-tip]')) moveTip(e.clientX, e.clientY);
  });
  document.addEventListener('pointerout', e => {
    if (e.target.closest('[data-tip]') && !e.relatedTarget?.closest?.('[data-tip]')) hideTip();
  });
  document.addEventListener('focusin', e => {
    const el = e.target.closest('.bar[data-tip]');
    if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left, r.bottom); }
  });
  document.addEventListener('focusout', hideTip);
  addEventListener('scroll', hideTip, { passive: true });

  // ---------- Copy /way ----------
  async function copyWay(btn) {
    const text = btn.dataset.way;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(`Copied: ${text}`);
  }
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }

  // ---------- Interaction ----------
  document.addEventListener('click', e => {
    const way = e.target.closest('[data-way]');
    if (way) { e.preventDefault(); e.stopPropagation(); copyWay(way); return; }
    const plan = e.target.closest('[data-plan]');
    if (plan) { e.preventDefault(); hideTip(); addToPlanner(plan.dataset.plan); return; }
    const ref = e.target.closest('[data-ref]');
    if (ref) { e.preventDefault(); e.stopPropagation(); hideTip(); openReference(ref.dataset.ref); return; }
    const opener = e.target.closest('[data-open]');
    if (opener) {
      e.preventDefault(); hideTip(); toggleDrawer(+opener.dataset.open); return;
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) { e.preventDefault(); gotoQuest(+goto.dataset.goto); return; }
    const floorBtn = e.target.closest('[data-floor]');
    if (floorBtn) { showFloor(+floorBtn.dataset.floor); return; }

    const bar = e.target.closest('.bar[data-tip]');
    if (bar && e.pointerType !== 'mouse') {          // touch: tap to show
      const r = bar.getBoundingClientRect();
      showTip(bar, e.clientX || r.left, e.clientY || r.bottom);
      return;
    }
    if (bar && bar.dataset.tip.startsWith('d:')) selectDungeon(bar.dataset.tip.split(':')[1]);
    if (bar && bar.dataset.tip.startsWith('q:')) toggleDrawer(QUESTS[+bar.dataset.tip.split(':')[1]].id);
    const jump = e.target.closest('[data-jump]');
    if (jump) { e.preventDefault(); selectDungeon(jump.dataset.jump); }
    if (e.target.closest('#clear-focus')) setFocus(null);
    const tog = e.target.closest('[data-toggle]');
    if (tog) toggle(tog.dataset.toggle);
    if (!bar) hideTip();
  });
  document.addEventListener('change', e => {
    const cb = e.target.closest('[data-done]');
    if (!cb) return;
    const id = +cb.dataset.done;
    cb.checked ? done.add(id) : done.delete(id);
    save();
    rerenderKeepingScroll();
    if (ref.open) renderReference(ref.dataset.key);
    document.dispatchEvent(new Event('forever:done'));
  });
  document.addEventListener('keydown', e => {
    const tog = e.target.closest?.('[data-toggle]');
    if (tog && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-ref], [data-plan]')) { e.preventDefault(); toggle(tog.dataset.toggle); }
    if (e.key === 'Escape' && !ref.open) { hideTip(); setFocus(null); }
  });

  function rerenderKeepingScroll() {
    const y = scrollY;
    renderAll();
    scrollTo(0, y);
  }
  // Add a dungeon to the route planner, or jump to it there if it's already in the route.
  function addToPlanner(key) {
    const P = window.ForeverPlanner;
    if (!P) return;
    if (P.has(key)) {
      if (ref.open) ref.close();
      P.show(key);
      return;
    }
    P.add(key);
    document.querySelectorAll(`[data-plan="${key}"]`).forEach(b => {
      b.innerHTML = planLabel(key);
      b.title = planTitle(key);
      b.setAttribute('aria-label', planTitle(key));
    });
  }

  function toggleDrawer(id) {
    open.has(id) ? open.delete(id) : open.add(id);
    rerenderKeepingScroll();
  }
  function gotoQuest(id) {
    const q = questById.get(id);
    if (!q) return;
    if (ref.open) ref.close();
    open.add(id);
    collapsed.delete(q.d);
    if (!questVisible(q)) {         // make sure it's on screen even if filters would hide it
      state.near = false; state.search = ''; state.q = ''; state.hideDone = false;
      syncControls(); save();
    }
    renderAll();
    document.querySelector(`.row.q[data-q="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function toggle(key) {
    collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    save();
    renderQuests();
    placeYou();
    document.querySelector(`[data-toggle="${key}"]`)?.focus({ preventScroll: true });
  }
  // Clicking a dungeon highlights its quest group and fades the rest; clicking it again clears.
  function selectDungeon(key) {
    if (focus === key) { setFocus(null); return; }
    if (collapsed.delete(key)) { save(); renderQuests(); placeYou(); }
    setFocus(key);
    document.getElementById(`g-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function setFocus(key) {
    focus = key;
    applyFocus();
  }
  function applyFocus() {
    $('#quest-timeline').classList.toggle('has-focus', !!focus);
    document.querySelectorAll('#quest-timeline .qgroup').forEach(g => g.classList.toggle('focus', g.dataset.d === focus));
    document.querySelectorAll('#dungeon-timeline .row.d').forEach(r => r.classList.toggle('selected', r.dataset.d === focus));
    const btn = $('#clear-focus');
    btn.hidden = !focus;
    if (focus) btn.textContent = `Clear highlight: ${byKey[focus]?.name ?? ''}`;
  }

  // ---------- Dungeon quick reference ----------
  const ref = $('#ref');
  let refFloor = 1;

  function openReference(key) {
    refFloor = 1;
    renderReference(key);
    if (!ref.open) ref.showModal();
    ref.querySelector('.ref-body').scrollTop = 0;
  }
  ref.addEventListener('click', e => { if (e.target === ref) ref.close(); });   // click backdrop to close

  function showFloor(n) {
    refFloor = n;
    renderReference(ref.dataset.key);
  }

  // A dungeon's map: DungeonJournal's own when it has an image, otherwise one from the
  // ForeverInstanceMaps addon (data/instance-maps.js), otherwise just DungeonJournal's boss list.
  // Floors may have names; boss pins are fractions of the floor image.
  const IM = window.FOREVER_INSTANCE_MAPS || { dungeons: {} };
  const dungeonMap = (key, jd) => (jd?.map?.floors?.length ? jd.map : IM.dungeons[key] || jd?.map || null);
  const mapSource = (key, jd) => (jd?.map?.floors?.length ? J.source || 'DungeonJournal' : IM.dungeons[key] ? IM.source : null);
  // Boss names in the map data can carry notes, like "Captain Greenskin (roams top of boat)".
  const bossKey = name => String(name).toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').trim();

  function mapHTML(m, name, source) {
    if (!m) return '';
    if (!m.floors.length) {
      const byFloor = {};
      m.bosses.forEach(b => (byFloor[b.floor] ||= []).push(b.name));
      return `<div class="ref-nomap"><p class="dim">No map image for this dungeon yet.</p>
        ${Object.entries(byFloor).map(([f, names]) => `<p><b>Level ${f}:</b> ${names.map(esc).join(', ')}</p>`).join('')}</div>`;
    }
    const floors = m.floors.filter(Boolean);
    const fl = m.floors[refFloor - 1] || floors[0];
    const bossNo = new Map(m.bosses.map((b, i) => [b, i + 1]));
    const pins = m.bosses.filter(b => b.floor === refFloor).map(b =>
      `<span class="pin boss" style="left:${b.x * 100}%;top:${b.y * 100}%" title="${esc(b.name)}"><i>${bossNo.get(b)}</i><em>${esc(b.name)}</em></span>`).join('');
    const ent = m.entrance && m.entrance.floor === refFloor
      ? `<span class="pin entrance" style="left:${m.entrance.x * 100}%;top:${m.entrance.y * 100}%" title="Entrance"><i style="transform:rotate(${-(m.entrance.angle || 0)}deg)">➜</i><em>Entrance</em></span>` : '';
    const trans = (m.transitions || []).filter(t => t.floor === refFloor).map(t =>
      `<button type="button" class="pin stairs" style="left:${t.x * 100}%;top:${t.y * 100}%" data-floor="${t.to}" title="To level ${t.to}"><i>⇅</i><em>Level ${t.to}</em></button>`).join('');
    const floorName = (f, i) => f.name || `Level ${i + 1}`;
    const tabs = m.floors.length > 1
      ? `<div class="floor-tabs">${m.floors.map((f, i) => f ? `<button type="button" class="wow-btn small${i + 1 === refFloor ? ' active' : ''}" data-floor="${i + 1}">${esc(floorName(f, i))}</button>` : '').join('')}</div>` : '';
    return `${tabs}
      <div class="map-wrap" style="aspect-ratio:${fl.width}/${fl.height}">
        <img src="${fl.image}" alt="${esc(name)} map, ${esc(floorName(fl, m.floors.indexOf(fl)))}" loading="lazy">
        ${ent}${trans}${pins}
      </div>
      <p class="dim small"><a href="${fl.image}" target="_blank" rel="noopener">Open full-size map ↗</a>${source ? ` · Map from ${esc(source)}` : ''}</p>`;
  }

  function renderReference(key) {
    const d = byKey[key];
    const jd = J.dungeons[key];
    ref.dataset.key = key;
    const g = d.guide;
    const quests = QUESTS.filter(q => q.d === key).sort((a, b) => a.from - b.from || a.name.localeCompare(b.name));
    const entrance = jd?.entrance ? { place: jd.entrance.label || ZONES[jd.entrance.mapID], pt: pointFrom(jd.entrance) } : null;
    const routeFor = jd?.route && (state.faction === 'all' || state.faction === (jd.route.faction === 'Horde' ? 'H' : 'A'));
    const bosses = jd?.bosses || [];
    const map = dungeonMap(key, jd);
    const bossNo = new Map((map?.floors?.length ? map.bosses : []).map((b, i) => [bossKey(b.name), i + 1]));

    ref.innerHTML = `
      <div class="ref-frame">
        <header class="ref-head">
          <div>
            <h2>${esc(d.name)} ${d.type === 'new' ? '<span class="new-tag">New</span>' : ''}</h2>
            <p class="dim">Levels ${d.min}–${d.max} · ${esc(jd?.location || d.zone)}</p>
          </div>
          <span class="spacer"></span>
          ${planBtn(key)}
          <button type="button" class="close-x" onclick="this.closest('dialog').close()" aria-label="Close">✕</button>
        </header>
        <div class="ref-body">
          <div class="ref-cols">
            <section>
              ${jd?.description || d.note ? `<p class="ref-desc">${esc(jd?.description || d.note)}</p>` : ''}
              ${entrance ? `<h3>Entrance</h3><p>${locHTML(entrance)}</p>${jd.entrance.detail ? `<p class="dim">${esc(jd.entrance.detail)}</p>` : ''}` : `<h3>Location</h3><p>${esc(d.zone)}</p>`}
              ${g ? `<h3>Suggested levels</h3><div class="t-diff ref-diff">
                <span class="d-red">${g.hard}<small>Hard</small></span>
                <span class="d-orange">${g.medium}<small>Medium</small></span>
                <span class="d-yellow">${g.at}<small>At level</small></span>
                ${g.easy ? `<span class="d-green">${g.easy}<small>Easy</small></span>` : ''}</div>` : ''}
              ${mapHTML(map, d.name, mapSource(key, jd))}
            </section>
            <section>
              ${bosses.length ? `<h3>Bosses</h3><ol class="bosses">${bosses.map(b => `
                <li>
                  <details>
                    <summary>${bossNo.has(bossKey(b.name)) ? `<span class="pin-no">${bossNo.get(bossKey(b.name))}</span>` : '<span class="pin-no blank"></span>'}<b>${esc(b.name)}</b>${b.level ? ` <span class="dim">Lv ${esc(b.level)}</span>` : ''}${b.loot?.length ? ` <span class="dim small">· ${b.loot.length} drops</span>` : ''}</summary>
                    ${b.loot?.length ? `<ul class="loot">${b.loot.map(it => `<li><a class="${QUALITY[it.quality] || ''}" href="${WOWHEAD}item=${it.id}" target="_blank" rel="noopener">${esc(it.name)}</a> <span class="dim small">${esc(it.slot || '')}</span></li>`).join('')}</ul>` : ''}
                  </details>
                </li>`).join('')}</ol>` : ''}
              <h3>Quests <span class="dim">· ${quests.filter(q => done.has(q.id)).length}/${quests.length} done</span></h3>
              ${quests.length ? `<ul class="ref-quests">${quests.map(q => {
                const [fc, fl, ft] = SIDE[q.side] || SIDE.B;
                const chain = chainFor(q);
                return `<li class="${done.has(q.id) ? 'done' : ''}">
                  <label class="check"><input type="checkbox" data-done="${q.id}"${done.has(q.id) ? ' checked' : ''}><span class="sr">Completed</span></label>
                  <span class="fac ${fc}" title="${ft}">${fl}</span>
                  <a href="#" class="d-${diffAt(q, state.level)}" data-goto="${q.id}">${esc(q.name)}</a>
                  <span class="dim small">${q.from}–${q.to}</span>
                  ${chainBadge(q, chain)}
                  <span class="spacer"></span>
                  ${locHTML(questLocation(q.id))}
                </li>`;
              }).join('')}</ul>` : '<p class="dim">No quest data yet.</p>'}
              ${routeFor ? `<h3>${esc(jd.route.title)}</h3><ol class="route">${jd.route.steps.map(s => `
                <li><b>${esc(s.title)}</b><p>${esc(s.text)}</p>${s.map ? locHTML({ place: s.map.label, pt: pointFrom(s.map) }) : ''}</li>`).join('')}</ol>` : ''}
              ${!jd ? '<p class="dim small">No boss or map data for this dungeon yet.</p>' : ''}
            </section>
          </div>
        </div>
      </div>`;
  }

  // ---------- Controls ----------
  const levelInput = $('#level');
  const levelOut = $('#level-out');
  function syncControls() {
    levelInput.value = state.level;
    levelOut.textContent = state.level;
    document.querySelectorAll('.seg[data-key]').forEach(seg => {
      seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === state[seg.dataset.key])));
    });
    $('#share').checked = state.share;
    $('#near').checked = state.near;
    $('#hide-done').checked = state.hideDone;
    $('#fade-far').checked = state.fadeFar;
    $('#cls').value = state.cls;
    $('#search').value = state.search;
  }

  function renderAll() {
    renderDungeons();
    renderQuests();
    placeYou();
  }

  let raf = 0;
  levelInput.addEventListener('input', () => {
    state.level = +levelInput.value;
    levelOut.textContent = state.level;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { renderAll(); save(); });
  });
  document.querySelectorAll('.seg[data-key]').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state[seg.dataset.key] = b.dataset.value;
    syncControls(); renderAll(); save();
  }));
  $('#share').addEventListener('change', e => { state.share = e.target.checked; renderAll(); save(); });
  $('#near').addEventListener('change', e => {
    state.near = e.target.checked;
    if (state.near) state.fadeFar = false;
    syncControls(); renderAll(); save();
  });
  $('#hide-done').addEventListener('change', e => { state.hideDone = e.target.checked; renderAll(); save(); });
  // Hiding and fading out-of-range items are alternatives: ticking one unticks the other.
  $('#fade-far').addEventListener('change', e => {
    state.fadeFar = e.target.checked;
    if (state.fadeFar) state.near = false;
    syncControls(); renderAll(); save();
  });
  $('#cls').addEventListener('change', e => { state.cls = e.target.value; renderAll(); save(); });
  $('#search').addEventListener('input', e => {
    state.search = e.target.value;
    state.q = state.search.trim().toLowerCase();
    renderAll(); save();
  });
  $('#expand-all').addEventListener('click', () => { collapsed.clear(); save(); renderQuests(); placeYou(); });
  $('#collapse-all').addEventListener('click', () => { DUNGEONS.forEach(d => collapsed.add(d.key)); save(); renderQuests(); placeYou(); });

  if (RAW.fetched) {
    $('#fetched').textContent = `Quest data last refreshed ${new Date(RAW.fetched).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}.`;
  }

  syncControls();
  renderAll();

  // Shared with the route planner (js/planner.js).
  window.ForeverTimeline = {
    DUNGEONS, QUESTS, questById, byKey, done, ZONES,
    diffAt, questLocation, locHTML, chainFor, chainProgress, esc, toast, hideTip, renderAll,
  };
})();
