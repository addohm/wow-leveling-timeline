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
    notes: [{ lv: 13, text: 'Start the sleeping bag chain' }],
  };

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
  // Notes: { lv, text, quest?, url? } pinned to a level; `quest` is a Wowhead quest ID, `url` any web link.
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
      const text = String(n?.text ?? '').trim().slice(0, 200);
      if (!text) continue;
      const quest = /^\d{1,7}$/.test(String(n.quest ?? '')) ? String(n.quest) : '';
      const url = quest ? '' : parseLink(n.url).url || '';
      out.notes.push({ id: uid(), lv: clampInt(n.lv, 1, 60, 1), text, quest, url });
    }
    sortSteps(out);
    return out;
  }

  // Level order; a zone or longer run comes before a point that starts at the same level.
  // A note's link: a Wowhead quest ID, or an http(s) address. Returns {} when empty, { error } when invalid.
  function parseLink(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return {};
    if (/^\d{1,7}$/.test(s)) return { quest: s };
    try {
      const u = new URL(/^[a-z][\w+.-]*:/i.test(s) ? s : `https://${s}`);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && u.href.length <= 500) return { url: u.href };
    } catch { /* not a URL */ }
    return { error: 'Enter a Wowhead quest ID like 96403, or a web address like https://www.wowhead.com/…' };
  }

  // Validates note fields; returns the note's values or { error }.
  function readNote(lvRaw, textRaw, linkRaw) {
    const lv = Math.round(Number(String(lvRaw).trim()));
    const text = String(textRaw).trim();
    if (!String(lvRaw).trim() || !(lv >= 1 && lv <= 60)) return { error: 'Enter a level from 1 to 60.' };
    if (!text) return { error: 'Enter the note text.' };
    const link = parseLink(linkRaw);
    if (link.error) return link;
    return { lv, text: text.slice(0, 200), quest: link.quest || '', url: link.url || '' };
  }

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
      notes: p.notes.map(n => ({ lv: n.lv, text: n.text, ...(n.quest && { quest: n.quest }), ...(n.url && { url: n.url }) })),
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

  let plan = load();
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
  let AMIN = 1, AMAX = 30;
  const pct = L => ((Math.max(AMIN, Math.min(AMAX, L)) - AMIN) / (AMAX - AMIN)) * 100;

  function axisRange() {
    const top = Math.max(routeEnd(), ...plan.notes.map(n => n.lv));
    const low = Math.min(plan.start, ...plan.steps.map(s => s.from));
    AMIN = Math.max(1, Math.floor((low - 1) / 5) * 5) || 1;
    AMAX = Math.min(60, Math.max(AMIN + 20, Math.ceil((top + 4) / 5) * 5));
  }

  function gridHTML() {
    let h = '<div class="grid" aria-hidden="true">';
    for (const [a, b] of gaps()) h += `<i class="gap" style="left:${pct(a)}%;width:${pct(b) - pct(a)}%"></i>`;
    for (let L = AMIN; L <= AMAX; L++) h += `<i class="gl${L % 5 === 0 ? ' major' : ''}" style="left:${pct(L)}%"></i>`;
    h += '</div><div class="grid top" aria-hidden="true">';
    for (const n of plan.notes) {
      if (n.lv >= AMIN && n.lv <= AMAX) h += `<i class="note-line" style="left:${pct(n.lv)}%"></i>`;
    }
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

  function stepRow(s, i, notesHere) {
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
      <div class="row pstep ${s.t}${isOpen ? ' open' : ''}" data-sid="${s.id}">
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

  function noteLinkHTML(n) {
    if (n.url) {
      let host = n.url;
      try { host = new URL(n.url).hostname.replace(/^www\./, ''); } catch { /* keep the raw link */ }
      return ` <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(host)} ↗</a>`;
    }
    if (!n.quest) return '';
    const q = questById.get(+n.quest);
    return q
      ? ` <a href="#" class="d-${diffAt(q, n.lv)}" data-goto="${q.id}" data-tip="q:${q.idx}">${esc(q.name)}</a>`
      : ` <a href="${WOWHEAD}quest=${esc(n.quest)}" target="_blank" rel="noopener">Quest ${esc(n.quest)} on Wowhead ↗</a>`;
  }

  let editingNote = null;          // id of the note being edited in place

  function renderNotes() {
    const list = [...plan.notes].sort((a, b) => a.lv - b.lv);
    $('#p-notes').innerHTML = list.length ? list.map(n => {
      if (n.id === editingNote) {
        return `
          <li class="note-editing">
            <form class="note-form" data-edit-note="${n.id}" novalidate>
              <input type="number" class="num" data-nf="lv" min="1" max="60" step="1" value="${n.lv}" aria-label="Level">
              <input type="text" data-nf="text" value="${esc(n.text)}" maxlength="200" aria-label="Note">
              <input type="text" data-nf="link" value="${esc(n.url || n.quest)}" placeholder="Link: quest ID or URL (optional)" maxlength="500" aria-label="Link: Wowhead quest ID or web address">
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
        <li>
          <span class="note-lv">${n.lv}</span>
          <div class="note-body">
            <div>${esc(n.text)}${noteLinkHTML(n)}</div>
            <div class="dim small">${owners.length ? `During ${owners.map(s => esc(stepName(s))).join(', ')}` : 'Outside your route'}</div>
          </div>
          <button type="button" class="wow-btn small" data-edit="${n.id}">Edit</button>
          <button type="button" class="close-x" data-del-note="${n.id}" aria-label="Remove note">✕</button>
        </li>`;
    }).join('') : '<li class="dim">No notes yet. Pin a reminder to a level, like a quest chain to start or a class trainer visit.</li>';
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
  }

  function render() {
    axisRange();
    const notesFor = {};
    for (const n of plan.notes) for (const s of noteOwners(n)) (notesFor[s.id] ||= []).push(n);
    const rows = plan.steps.map((s, i) => stepRow(s, i, (notesFor[s.id] || []).sort((a, b) => a.lv - b.lv)));
    const y = scrollY;
    $('#route-timeline').innerHTML = gridHTML() + axisHTML() + (rows.length ? rows.join('')
      : '<div class="no-results">No steps yet. Add a zone, dungeon or custom step below, or load the example route.</div>');
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
    const n = readNote($('#p-note-lv').value, $('#p-note-text').value, $('#p-note-link').value);
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
    const f = name => form.querySelector(`[data-nf="${name}"]`);
    const n = readNote(f('lv').value, f('text').value, f('link').value);
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
