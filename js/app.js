(() => {
  'use strict';

  const LMIN = 10;
  const LMAX = 60;
  const CELLS = LMAX - LMIN + 1;           // level L occupies the cell [L, L+1)
  const STORE_KEY = 'forever-timeline-v1';
  const WOWHEAD = 'https://www.wowhead.com/forever/quest=';

  const DUNGEONS = window.FOREVER_DUNGEONS || [];
  const RAW = window.FOREVER_QUESTS || { quests: [] };
  const byKey = Object.fromEntries(DUNGEONS.map(d => [d.key, d]));

  // Normalise quests: `from` = first level the quest is not red, `to` = level it turns grey.
  const QUESTS = RAW.quests.map((q, i) => ({
    ...q,
    idx: i,
    from: q.orange ?? q.yellow ?? q.green ?? q.req,
    to: q.grey ?? (q.level + 6),
  }));

  // ---------- State ----------
  // Every setting is remembered in this browser between visits.
  const defaults = { level: 15, faction: 'all', type: 'all', cls: '', share: false, near: true, search: '', collapsed: [] };
  const state = { ...defaults, ...load() };
  state.q = state.search.trim().toLowerCase();   // normalised search, derived from `search`
  const collapsed = new Set(state.collapsed);
  let focus = null;   // dungeon key highlighted in the quest timeline

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
      return Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in defaults && typeof v === typeof defaults[k]));
    } catch { return {}; }
  }
  function save() {
    try {
      const { q, collapsed: _, ...rest } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...rest, collapsed: [...collapsed] }));
    } catch { /* storage unavailable */ }
  }

  // ---------- Helpers ----------
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pct = L => ((clamp(L, LMIN, LMAX + 1) - LMIN) / CELLS) * 100;

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
    if (state.cls === 'none' && (q.classes || q.profession)) return false;
    if (state.cls && state.cls !== 'none' && q.classes && !q.classes.includes(state.cls)) return false;
    if (state.q) {
      const hay = `${q.name} ${d ? d.name + ' ' + d.zone : ''} ${q.start || ''} ${q.starts || ''} ${q.wing || ''}`.toLowerCase();
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
    document.querySelectorAll('.grid .you').forEach(el => {
      el.style.left = `${x}%`;
      el.hidden = state.level < LMIN;
    });
  }

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
      rows.push(`
        <div class="row d${inRange ? ' in-range' : ''}${focus === d.key ? ' selected' : ''}" data-d="${d.key}">
          <div class="label">
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
  function questRow(q) {
    const [fc, fl, ft] = SIDE[q.side] || SIDE.B;
    const diff = diffAt(q, state.level);
    const tags = (q.flags || []).map(f => FLAG[f] ? `<span class="tag" title="${FLAG[f][1]}">${FLAG[f][0]}</span>` : '').join('');
    const cls = (q.classes || []).map(c => `<span class="tag tag-class c-${esc(c)}" title="${esc(c)} only">${esc(c)}</span>`).join('');
    const prof = q.profession ? `<span class="tag tag-class c-prof" title="${esc(q.profession)} only">${esc(q.profession)}</span>` : '';
    const share = q.share
      ? '<span class="ico ico-share" title="Shareable">⇄</span>'
      : '<span class="ico ico-noshare" title="Not shareable">⇄</span>';
    const runsOn = q.to > LMAX + 1;
    const notches = [q.yellow, q.green]
      .filter(v => v != null && v > q.from && v < Math.min(q.to, LMAX + 1))
      .map(v => `<i class="notch" style="left:${((v - q.from) / (Math.min(q.to, LMAX + 1) - q.from)) * 100}%"></i>`).join('');
    const doable = state.level >= q.from && state.level < q.to;
    return `
      <div class="row q${doable ? '' : ' dim'}">
        <div class="label">
          <span class="fac ${fc}" title="${ft}">${fl}</span>
          <a class="name d-${diff}" href="${WOWHEAD}${q.id}" target="_blank" rel="noopener">${esc(q.name)}</a>
          ${cls}${prof}${tags}${share}
        </div>
        <div class="track">
          <span class="bar quest${runsOn ? ' runs-on' : ''}" style="${barStyle(q.from, q.to)}" tabindex="0" data-tip="q:${q.idx}">${notches}${q.from}–${q.to}</span>
        </div>
      </div>`;
  }

  function renderQuests() {
    const out = [];
    let shown = 0;
    const filtering = state.faction !== 'all' || state.share || state.cls || state.q;

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
      g.push(`
        <div class="row group-head${isCollapsed ? ' collapsed' : ''}" id="g-${d.key}">
          <div class="label" role="button" tabindex="0" aria-expanded="${!isCollapsed}" data-toggle="${d.key}">
            <span class="caret">▼</span>
            <span class="name">${esc(d.name)}</span>
            ${d.type === 'new' ? '<span class="new-tag">New</span>' : ''}
            <span class="spacer"></span>
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
    return `
      <div class="t-title d-${diff}">${esc(q.name)}</div>
      <div class="t-gold">${esc(d ? d.name : '')}${q.wing ? ` · ${esc(q.wing)}` : ''}</div>
      <div>Level ${q.level} · Requires level ${q.req}</div>
      <div>${side}</div>
      <div class="${q.share ? 't-green' : 't-red'}">${q.share ? 'Shareable' : 'Not shareable'}</div>
      <div class="t-diff">${steps.map(([c, n, v]) => `<span class="${c}">${v}<small>${n}</small></span>`).join('')}</div>
      <div class="t-sep"></div>
      ${q.starts ? `<div class="t-dim">Starts: ${esc(q.starts)}</div>` : ''}
      ${flags.length ? `<div class="t-note">${flags.map(esc).join(' · ')}</div>` : ''}
      <div class="t-dim" style="margin-top:4px">Doable from ${q.from} until it greys out at ${q.to}.</div>`;
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
    const el = e.target.closest('[data-tip]');
    if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left, r.bottom); }
  });
  document.addEventListener('focusout', hideTip);
  addEventListener('scroll', hideTip, { passive: true });

  // ---------- Interaction ----------
  document.addEventListener('click', e => {
    const bar = e.target.closest('[data-tip]');
    if (bar && e.pointerType !== 'mouse') {          // touch: tap to show
      const r = bar.getBoundingClientRect();
      showTip(bar, e.clientX || r.left, e.clientY || r.bottom);
      return;
    }
    if (bar && bar.dataset.tip.startsWith('d:')) selectDungeon(bar.dataset.tip.split(':')[1]);
    const jump = e.target.closest('[data-jump]');
    if (jump) { e.preventDefault(); selectDungeon(jump.dataset.jump); }
    if (e.target.closest('#clear-focus')) setFocus(null);
    const tog = e.target.closest('[data-toggle]');
    if (tog) toggle(tog.dataset.toggle);
    if (!bar) hideTip();
  });
  document.addEventListener('keydown', e => {
    const tog = e.target.closest?.('[data-toggle]');
    if (tog && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(tog.dataset.toggle); }
    if (e.key === 'Escape') { hideTip(); setFocus(null); }
  });

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

  // Controls
  const levelInput = $('#level');
  const levelOut = $('#level-out');
  function syncControls() {
    levelInput.value = state.level;
    levelOut.textContent = state.level;
    document.querySelectorAll('.seg').forEach(seg => {
      seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.value === state[seg.dataset.key])));
    });
    $('#share').checked = state.share;
    $('#near').checked = state.near;
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
  document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    state[seg.dataset.key] = b.dataset.value;
    syncControls(); renderAll(); save();
  }));
  $('#share').addEventListener('change', e => { state.share = e.target.checked; renderAll(); save(); });
  $('#near').addEventListener('change', e => { state.near = e.target.checked; renderAll(); save(); });
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
})();
