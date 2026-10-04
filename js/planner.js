// Route planner: an ordered list of zones and dungeon runs on a level axis, plus notes pinned to a level.
// Uses the quest and dungeon data that js/app.js exposes as window.ForeverTimeline.
(() => {
  'use strict';

  const T = window.ForeverTimeline;
  if (!T) return;
  const { DUNGEONS, QUESTS, questById, byKey, done, diffAt, questLocation, locHTML, esc, toast } = T;
  const ZONES = window.FOREVER_ZONES || [];
  const zoneByKey = Object.fromEntries(ZONES.map(z => [z.key, z]));

  const STORE_KEY = 'forever-planner-v1';
  const TAB_KEY = 'forever-tab';
  const WOWHEAD = 'https://www.wowhead.com/forever/';
  const CLASSES = ['Druid', 'Hunter', 'Mage', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior'];
  const FACTION = { A: 'Alliance', H: 'Horde' };

  const EXAMPLE = {
    faction: 'A', cls: '', start: 1,
    steps: [
      { t: 'zone', k: 'dunmorogh', end: 12 },
      { t: 'dungeon', k: 'hot', end: 14 },
      { t: 'dungeon', k: 'rol', end: 16 },
      { t: 'dungeon', k: 'wc', end: 18 },
      { t: 'zone', k: 'westfall', end: 20 },
      { t: 'dungeon', k: 'dm', end: 22 },
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
  // Steps: { t: 'zone', k, end } or { t: 'dungeon', k, wing?, end, pick: { questId: bool } }.
  // Each step starts where the previous one ends; the first starts at `start`.
  // Notes: { lv, text, quest? } pinned to a level, so they stay put when steps are reordered.
  function clean(p) {
    const out = {
      faction: p?.faction === 'H' ? 'H' : 'A',
      cls: CLASSES.includes(p?.cls) ? p.cls : '',
      start: clampInt(p?.start, 1, 59, 1),
      steps: [],
      notes: [],
    };
    for (const s of Array.isArray(p?.steps) ? p.steps : []) {
      if (s?.t === 'zone' && zoneByKey[s.k]) {
        out.steps.push({ id: uid(), t: 'zone', k: s.k, end: clampInt(s.end, 1, 60, 1) });
      } else if (s?.t === 'dungeon' && byKey[s.k]) {
        const wing = byKey[s.k].wings?.some(w => w.name === s.wing) ? s.wing : undefined;
        const pick = {};
        for (const [id, v] of Object.entries(s.pick || {})) if (/^\d+$/.test(id) && typeof v === 'boolean') pick[id] = v;
        out.steps.push({ id: uid(), t: 'dungeon', k: s.k, wing, end: clampInt(s.end, 1, 60, 1), pick });
      }
    }
    for (const n of Array.isArray(p?.notes) ? p.notes : []) {
      const text = String(n?.text ?? '').trim().slice(0, 200);
      if (!text) continue;
      const quest = /^\d{1,7}$/.test(String(n.quest ?? '')) ? String(n.quest) : '';
      out.notes.push({ id: uid(), lv: clampInt(n.lv, 1, 60, 1), text, quest });
    }
    return out;
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
      notes: p.notes.map(({ id, ...n }) => (n.quest ? n : { lv: n.lv, text: n.text })),
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
  let lastOpen = null;             // most recently opened step; new steps are inserted after it

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
  const stepName = s => s.t === 'zone' ? zoneByKey[s.k].name : byKey[s.k].name + (s.wing ? ` · ${s.wing}` : '');
  const dungeonRange = s => (s.wing && byKey[s.k].wings?.find(w => w.name === s.wing)) || byKey[s.k];

  // Each step's start and (effective) end level.
  function layout() {
    let L = plan.start;
    return plan.steps.map(s => {
      const from = L;
      const end = Math.max(s.end, from);
      L = end;
      return { s, from, end };
    });
  }

  function prepQuests(s) {
    return QUESTS.filter(q => q.d === s.k
      && (q.side === 'B' || q.side === plan.faction)
      && (!s.wing || !q.wing || q.wing === s.wing)
      && !(q.classes && plan.cls && !q.classes.includes(plan.cls)));
  }
  // By default take every quest except profession quests, and class quests when no class is set.
  const defaultTake = q => !q.profession && !(q.classes && !plan.cls);
  const taking = (s, q) => s.pick?.[q.id] ?? defaultTake(q);

  function warnings({ s, from, end }) {
    const w = [];
    if (s.end < from) w.push(['warn', `Set to end at ${s.end}, but you’re already ${from} here, so it gains no levels.`]);
    if (s.t === 'zone') {
      const z = zoneByKey[s.k];
      if (z.side !== 'C' && z.side !== plan.faction) w.push(['warn', `${z.name} is a ${FACTION[z.side]} zone.`]);
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

  // The step a note falls in: the one covering its level, or the step that ends exactly there.
  function noteOwner(n, lay) {
    const i = lay.findIndex(x => n.lv >= x.from && n.lv < x.end);
    if (i >= 0) return lay[i].s.id;
    for (let j = lay.length - 1; j >= 0; j--) if (lay[j].end === n.lv) return lay[j].s.id;
    return null;
  }

  // ---------- Rendering ----------
  let AMIN = 1, AMAX = 30;
  const pct = L => ((Math.max(AMIN, Math.min(AMAX, L)) - AMIN) / (AMAX - AMIN)) * 100;

  function axisRange(lay) {
    const top = Math.max(plan.start, ...lay.map(x => x.end), ...plan.notes.map(n => n.lv));
    AMIN = Math.max(1, Math.floor((plan.start - 1) / 5) * 5) || 1;
    AMAX = Math.min(60, Math.max(AMIN + 20, Math.ceil((top + 4) / 5) * 5));
  }

  function gridHTML() {
    let h = '<div class="grid" aria-hidden="true">';
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

  function stepRow(x, i, notesHere) {
    const { s, from, end } = x;
    const w = warnings(x);
    const isOpen = open.has(s.id);
    const worst = w.find(v => v[0] === 'bad') || w[0];
    const warnIco = worst ? `<span class="warn-ico ${worst[0]}" title="${esc(w.map(v => v[1]).join('\n'))}">⚠</span>` : '';
    const noteIco = notesHere.length ? `<span class="note-ico" title="${esc(notesHere.map(n => `${n.lv}: ${n.text}`).join('\n'))}">⚑</span>` : '';
    const left = pct(from);
    const width = Math.max(pct(end) - left, 0.8);
    let bar;
    if (s.t === 'zone') {
      bar = `<span class="pbar zone" style="left:${left}%;width:${width}%" title="${esc(stepName(s))}: ${from}–${end}">${from}–${end}</span>`;
    } else {
      const qs = prepQuests(s);
      const n = qs.filter(q => taking(s, q)).length;
      bar = `<span class="pbar dungeon${byKey[s.k].type === 'new' ? ' is-new' : ''}" style="left:${left}%;width:${width}%" data-tip="d:${s.k}${s.wing ? ':' + esc(s.wing) : ''}">${from}–${end}</span>`
        + `<span class="pdiamond" style="left:${left}%" title="Pick up ${n} of ${qs.length} quests before the run"></span>`;
    }
    const prep = s.t === 'dungeon'
      ? (() => { const qs = prepQuests(s); return `<span class="prep-badge" title="Quests you’re taking">⬥ ${qs.filter(q => taking(s, q)).length}/${qs.length}</span>`; })()
      : '';
    return `
      <div class="row pstep ${s.t}${isOpen ? ' open' : ''}" data-sid="${s.id}">
        <div class="label">
          <span class="pnum">${i + 1}</span>
          <button type="button" class="pname" data-pstep="${s.id}" aria-expanded="${isOpen}">${esc(stepName(s))}</button>
          ${s.t === 'dungeon' && byKey[s.k].type === 'new' ? '<span class="new-tag">New</span>' : ''}
          ${prep}${warnIco}${noteIco}
          <span class="spacer"></span>
          <span class="prange">${from} →</span>
          <input type="number" class="num pend" min="1" max="60" step="1" value="${s.end}" data-end="${s.id}" aria-label="Level you leave ${esc(stepName(s))} at">
        </div>
        <div class="track" data-pstep="${s.id}">${bar}</div>
      </div>
      ${isOpen ? drawerHTML(x, w, notesHere) : ''}`;
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

  function dungeonDetail(s, from) {
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
      <h4>Quest pickups <span class="dim">· taking ${n} of ${qs.length} · name colours show difficulty at ${from}</span></h4>
      ${ordered.map(([place, g]) => `
        <div class="pickup-group">
          <div class="pickup-place">${esc(place)}</div>
          <ul class="ref-quests">${g.list.map(q => prepQuestHTML(s, q, from)).join('')}</ul>
        </div>`).join('')}
      <p class="dim small">Untick quests you’ll skip. Click a quest to open it on the timeline, where you can mark it complete.</p>`;
  }

  function zoneDetail(s, from, end) {
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
              <button type="button" class="wow-btn small" data-insert="dungeon:${d.key}">Add after this step</button>
            </li>`).join('')}</ul>` : '<p class="dim">None.</p>'}
        </div>
      </div>`;
  }

  function drawerHTML({ s, from, end }, w, notesHere) {
    const d = s.t === 'dungeon' ? byKey[s.k] : null;
    const z = s.t === 'zone' ? zoneByKey[s.k] : null;
    const sub = z ? `Zone ${z.min}–${z.max}` : `${esc(d.zone)} · ${dungeonRange(s).min}–${dungeonRange(s).max}`;
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
            <span class="dim">Levels ${from}–${end} · ${sub}</span>
            ${wingSel}
            ${d ? `<button type="button" class="wow-btn small" data-ref="${s.k}">📖 Quick reference</button>` : ''}
            <span class="spacer"></span>
            <button type="button" class="wow-btn small" data-move="-1">▲ Earlier</button>
            <button type="button" class="wow-btn small" data-move="1">▼ Later</button>
            <button type="button" class="wow-btn small" data-remove>Remove</button>
            <button type="button" class="close-x" data-pstep="${s.id}" aria-label="Close details">✕</button>
          </div>
          ${notesHere.map(n => `<p class="pnote">⚑ <b>At ${n.lv}:</b> ${esc(n.text)}${noteQuestHTML(n)}</p>`).join('')}
          ${w.map(([k, t]) => `<p class="pwarn ${k}">⚠ ${esc(t)}</p>`).join('')}
          ${d ? dungeonDetail(s, from) : zoneDetail(s, from, end)}
        </div>
      </div>`;
  }

  function noteQuestHTML(n) {
    if (!n.quest) return '';
    const q = questById.get(+n.quest);
    return q
      ? ` <a href="#" class="d-${diffAt(q, n.lv)}" data-goto="${q.id}" data-tip="q:${q.idx}">${esc(q.name)}</a>`
      : ` <a href="${WOWHEAD}quest=${esc(n.quest)}" target="_blank" rel="noopener">Quest ${esc(n.quest)} on Wowhead ↗</a>`;
  }

  function renderNotes(lay) {
    const byId = Object.fromEntries(lay.map(x => [x.s.id, x.s]));
    const list = [...plan.notes].sort((a, b) => a.lv - b.lv);
    $('#p-notes').innerHTML = list.length ? list.map(n => {
      const owner = noteOwner(n, lay);
      return `
        <li>
          <span class="note-lv">${n.lv}</span>
          <div class="note-body">
            <div>${esc(n.text)}${noteQuestHTML(n)}</div>
            <div class="dim small">${owner ? `During ${esc(stepName(byId[owner]))}` : 'Outside your route'}</div>
          </div>
          <button type="button" class="close-x" data-del-note="${n.id}" aria-label="Remove note">✕</button>
        </li>`;
    }).join('') : '<li class="dim">No notes yet. Pin a reminder to a level, like a quest chain to start or a class trainer visit.</li>';
  }

  function renderAddSelect() {
    const sel = $('#p-add');
    const prev = sel.value;
    const zones = ZONES.filter(z => z.side === 'C' || z.side === plan.faction).sort((a, b) => a.min - b.min || a.name.localeCompare(b.name));
    const dungeons = [...DUNGEONS].sort((a, b) => a.min - b.min || a.max - b.max);
    sel.innerHTML = `
      <optgroup label="Zones">${zones.map(z => `<option value="zone:${z.key}">${esc(z.name)} (${z.min}–${z.max})</option>`).join('')}</optgroup>
      <optgroup label="Dungeons">${dungeons.map(d => (d.wings
        ? d.wings.map(w => `<option value="dungeon:${d.key}:${esc(w.name)}">${esc(d.name)} · ${esc(w.name)} (${w.min}–${w.max})</option>`).join('')
        : `<option value="dungeon:${d.key}">${esc(d.name)} (${d.min}–${d.max})</option>`)).join('')}</optgroup>`;
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    const after = plan.steps.find(s => s.id === lastOpen && open.has(s.id));
    $('#p-add-hint').textContent = after ? `Adds after step ${plan.steps.indexOf(after) + 1}: ${stepName(after)}` : 'Adds to the end of your route';
  }

  function syncSettings() {
    document.querySelectorAll('#p-faction button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === plan.faction)));
    $('#p-cls').value = plan.cls;
    $('#p-start').value = plan.start;
  }

  function render() {
    const lay = layout();
    axisRange(lay);
    const notesFor = {};
    for (const n of plan.notes) {
      const o = noteOwner(n, lay);
      if (o) (notesFor[o] ||= []).push(n);
    }
    const rows = lay.map((x, i) => stepRow(x, i, (notesFor[x.s.id] || []).sort((a, b) => a.lv - b.lv)));
    const y = scrollY;
    $('#route-timeline').innerHTML = gridHTML() + axisHTML() + (rows.length ? rows.join('')
      : '<div class="no-results">No steps yet. Add a zone or dungeon below, or load the example route.</div>');
    scrollTo(0, y);
    renderNotes(lay);
    renderAddSelect();
    syncSettings();
  }

  // ---------- Editing ----------
  function change(fn) {
    fn();
    save();
    render();
  }

  function insertStep(value, afterId) {
    const [t, k, wing] = value.split(':');
    const lay = layout();
    let at = plan.steps.length;
    if (afterId) at = plan.steps.findIndex(s => s.id === afterId) + 1;
    const from = at > 0 ? lay[at - 1].end : plan.start;
    let step;
    if (t === 'zone') {
      const z = zoneByKey[k];
      step = { id: uid(), t, k, end: Math.min(60, Math.max(from + 1, Math.min(z.max, from + 4))) };
    } else {
      step = { id: uid(), t, k, wing: wing || undefined, end: Math.min(60, from + 1), pick: {} };
    }
    change(() => plan.steps.splice(at, 0, step));
    document.querySelector(`.pstep[data-sid="${step.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  const stepById = id => plan.steps.find(s => s.id === id);

  document.addEventListener('click', e => {
    // Quest links in the planner open the quest on the timeline: switch tabs before app.js scrolls to it.
    if (e.target.closest('#planner [data-goto], .notes-panel [data-goto]')) showTab('timeline');
  }, true);

  $('#planner').addEventListener('click', e => {
    if (e.target.closest('[data-way], [data-ref], [data-goto], a[href^="http"], input, select, label')) return;
    const ins = e.target.closest('[data-insert]');
    if (ins) { insertStep(ins.dataset.insert, ins.closest('[data-sid]').dataset.sid); return; }
    const del = e.target.closest('[data-del-note]');
    if (del) { change(() => { plan.notes = plan.notes.filter(n => n.id !== del.dataset.delNote); }); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const i = plan.steps.findIndex(s => s.id === mv.closest('[data-sid]').dataset.sid);
      const j = i + +mv.dataset.move;
      if (j >= 0 && j < plan.steps.length) change(() => { [plan.steps[i], plan.steps[j]] = [plan.steps[j], plan.steps[i]]; });
      return;
    }
    if (e.target.closest('[data-remove]')) {
      const id = e.target.closest('[data-sid]').dataset.sid;
      open.delete(id);
      change(() => { plan.steps = plan.steps.filter(s => s.id !== id); });
      return;
    }
    const tog = e.target.closest('[data-pstep]');
    if (tog) {
      const id = tog.dataset.pstep;
      if (open.has(id)) open.delete(id);
      else { open.add(id); lastOpen = id; }
      render();
    }
  });

  $('#planner').addEventListener('change', e => {
    const end = e.target.closest('[data-end]');
    if (end) {
      const s = stepById(end.dataset.end);
      if (s && end.value !== '') change(() => { s.end = clampInt(end.value, 1, 60, s.end); });
      else render();
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
    if (e.key === 'Enter' && e.target.matches('[data-end]')) e.target.blur();
  });

  $('#p-add-btn').addEventListener('click', () => {
    const after = plan.steps.find(s => s.id === lastOpen && open.has(s.id));
    insertStep($('#p-add').value, after?.id);
  });

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
  ['#p-note-lv', '#p-note-text', '#p-note-quest'].forEach(id => $(id).addEventListener('input', () => { noteErr.textContent = ''; }));
  $('#p-note-form').addEventListener('submit', e => {
    e.preventDefault();
    const lvRaw = $('#p-note-lv').value.trim();
    const lv = Math.round(Number(lvRaw));
    const text = $('#p-note-text').value.trim();
    const quest = $('#p-note-quest').value.trim();
    if (!lvRaw || !Number.isFinite(lv) || lv < 1 || lv > 60) { noteErr.textContent = 'Enter a level from 1 to 60.'; return; }
    if (!text) { noteErr.textContent = 'Enter the note text.'; return; }
    if (quest && !/^\d{1,7}$/.test(quest)) { noteErr.textContent = 'The quest ID is the number in the Wowhead link, like 96403.'; return; }
    change(() => plan.notes.push({ id: uid(), lv, text: text.slice(0, 200), quest }));
    $('#p-note-form').reset();
  });

  // Quests marked complete on the timeline show as done here too.
  document.addEventListener('forever:done', () => { if (!$('#planner').hidden) render(); });

  // ---------- Tabs ----------
  function showTab(name) {
    document.querySelectorAll('[data-view]').forEach(el => { el.hidden = el.dataset.view !== name; });
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    try { localStorage.setItem(TAB_KEY, name); } catch { /* storage unavailable */ }
    if (name === 'planner') render();
  }
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  let startTab = 'timeline';
  try { startTab = localStorage.getItem(TAB_KEY) === 'planner' ? 'planner' : 'timeline'; } catch { /* storage unavailable */ }
  if (importFromHash()) startTab = 'planner';
  showTab(startTab);
})();
