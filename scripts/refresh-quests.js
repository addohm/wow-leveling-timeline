/*
 * Refresh data/quests.js from Wowhead.
 *
 * Wowhead blocks non-browser requests, so this runs in your browser:
 *   1. Open https://www.wowhead.com/forever/guide/dungeons/every-dungeon-quest-location
 *   2. Open DevTools (F12) → Console, paste this whole file, press Enter.
 *   3. Wait for it to finish (~1–2 min, it is throttled to be polite).
 *      A file named quests.js downloads — replace data/quests.js with it.
 *
 * If a new guide section appears, add it to DUNGEON_FOR_HEADING below.
 */
(async () => {
  const DUNGEON_FOR_HEADING = [
    [/^ragefire/, 'rfc'], [/hall of thanes/, 'hot'], [/^wailing/, 'wc'], [/deadmines/, 'dm'],
    [/^ruins of lordaeron/, 'rol'], [/^shadowfang/, 'sfk'], [/^blackfathom/, 'bfd'], [/stockade/, 'stocks'],
    [/^excavation/, 'exc'], [/^gnomeregan/, 'gnomer'], [/^razorfen kraul/, 'rfk'], [/^scarlet/, 'sm'],
    [/^razorfen downs/, 'rfd'], [/^uldaman/, 'ulda'], [/^zul'farrak/, 'zf'], [/^maraudon/, 'mara'],
    [/sunken temple/, 'st'], [/^blackrock depths/, 'brd'], [/^lower blackrock|lbrs/, 'lbrs'],
    [/^dire maul/, 'dmaul'], [/^scholomance/, 'scholo'], [/^stratholme/, 'strat'], [/^upper blackrock/, 'ubrs'],
    [/dalaran/, 'dal'], [/drowned city/, 'drowned'], [/krol'dok/, 'krol'], [/alcaz/, 'alcaz'],
    [/blackmaw/, 'blackmaw'], [/shaper/, 'shaper'],
  ];
  // The guide's LBRS table currently has no heading of its own and sits under Dire Maul North.
  const LBRS_IDS = new Set([4724, 4981, 4903, 4701, 5089, 5001, 4862, 4729, 4866, 4742, 4867, 4788]);

  const CLASSES = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' };
  const RACES = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll' };
  const SIDES = { Alliance: 'A', Horde: 'H', Both: 'B' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  function wingFor(key, h3) {
    if (key === 'sm') return h3 || null;
    if (key === 'dmaul') return /east/i.test(h3) ? 'East' : /west/i.test(h3) ? 'West' : 'North';
    if (key === 'strat') return /live/i.test(h3) ? 'Live Side' : 'Undead Side';
    return null;
  }

  // 1. Read the guide tables.
  const root = document.querySelector('#guide-body') || document.body;
  const rows = [];
  let h2 = '', h3 = '';
  for (const el of root.querySelectorAll('h2, h3, table')) {
    if (el.tagName === 'H2') { h2 = clean(el.textContent); h3 = ''; continue; }
    if (el.tagName === 'H3') { h3 = clean(el.textContent); continue; }
    for (const tr of el.querySelectorAll('tr')) {
      const a = tr.querySelector('td a[href*="quest="]');
      if (!a) continue;
      const id = +a.href.match(/quest=(\d+)/)[1];
      const tds = [...tr.children];
      let key = (DUNGEON_FOR_HEADING.find(([re]) => re.test(h2.toLowerCase())) || [])[1];
      if (key === 'dmaul' && LBRS_IDS.has(id)) key = 'lbrs';
      if (!key) { console.warn('Unmapped heading, skipping:', h2, a.textContent); continue; }
      rows.push({ id, name: clean(a.textContent), d: key, wing: wingFor(key, h3),
        tags: clean(tds[4]?.textContent), starts: clean(tds[5]?.textContent) });
    }
  }
  console.log(`Found ${rows.length} quest rows. Fetching Quick Facts…`);

  // 2. Fetch each quest's Quick Facts (throttled).
  const facts = {};
  const ids = [...new Set(rows.map(r => r.id))];
  for (let i = 0; i < ids.length; i += 3) {
    await Promise.all(ids.slice(i, i + 3).map(async id => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const html = await (await fetch(`/forever/quest=${id}`)).text();
          const m = html.match(/printHtml\("(\[ul\]\[li\]Level.*?)", "infobox-contents/);
          if (m) { facts[id] = m[1].replace(/\\\//g, '/'); return; }
        } catch { /* retry */ }
        await sleep(2000 * (attempt + 1));
      }
      console.warn('No Quick Facts for quest', id);
    }));
    await sleep(350);
    if (i % 30 === 0) console.log(`  ${Math.min(i + 3, ids.length)}/${ids.length}`);
  }

  // 3. Parse.
  const quests = rows.map(r => {
    const o = { id: r.id, name: r.name, d: r.d, side: 'B', share: false,
      red: null, orange: null, yellow: null, green: null, grey: null, req: null, level: null, start: null, starts: r.starts };
    const extra = [];
    for (const [, li] of (facts[r.id] || '').matchAll(/\[li\](.*?)\[\/li\]/g)) {
      let m;
      if ((m = li.match(/^Level: (\d+)/))) o.level = +m[1];
      else if ((m = li.match(/^Requires level (\d+)/))) o.req = +m[1];
      else if ((m = li.match(/^Side: (?:\[span[^\]]*\])?(\w+)/))) o.side = SIDES[m[1]] || 'B';
      else if (/^Sharable/.test(li)) o.share = true;
      else if (li.startsWith('Difficulty:')) {
        const map = { q10: 'red', r1: 'orange', r2: 'yellow', r3: 'green', r4: 'grey' };
        for (const [, c, v] of li.matchAll(/\[color=(\w+)\](\d+)\[/g)) if (map[c]) o[map[c]] = +v;
      }
      else if ((m = li.match(/quest-start\]Start: \[url=[^\]]*\](.*?)\[/))) o.start = m[1];
      else extra.push(li);
    }
    const ex = extra.join(' ');
    if (r.wing) o.wing = r.wing;
    const flags = [];
    if (/Pre/.test(r.tags)) flags.push('pre');
    if (/Drop/.test(r.tags)) flags.push('drop');
    if (/Esc/.test(r.tags)) flags.push('escort');
    if (/Interactable/.test(r.tags)) flags.push('object');
    if (/tbd/i.test(r.tags)) flags.push('tbd');
    if (/Repeatable/.test(ex)) flags.push('repeatable');
    if (flags.length) o.flags = flags;
    const blacksmith = /Blacksmiths Only/i.test(r.starts);
    const classes = [...ex.matchAll(/\[class=(\d+)\]/g)].map(m => CLASSES[m[1]]).filter(Boolean);
    if (blacksmith) o.profession = 'Blacksmithing';
    else if (classes.length) o.classes = classes;
    const races = [...ex.matchAll(/\[race=(\d+)\]/g)].map(m => RACES[m[1]]).filter(Boolean);
    if (races.length) o.races = races;
    return o;
  });

  const payload = { fetched: new Date().toISOString(), quests };
  const js = '// Generated by scripts/refresh-quests.js — do not edit by hand.\n' +
    `window.FOREVER_QUESTS = ${JSON.stringify(payload, null, 1)};\n`;
  window.__foreverQuestsJS = js;
  console.log(`Done: ${quests.length} quests.`);

  if (!window.__NO_DOWNLOAD) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
    a.download = 'quests.js';
    a.click();
  }
})();
