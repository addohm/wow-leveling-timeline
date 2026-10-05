# WoW: Forever Dungeon Timeline

A classic-WoW-styled timeline of every **World of Warcraft: Forever** dungeon and its dungeon quests.

- **Dungeons** (green): each dungeon's level range, from Wowhead's
  [Dungeons Overview](https://www.wowhead.com/forever/guide/dungeons-overview-locations-details).
- **Dungeon quests** (orange): each quest's bar starts at the first level where it's
  no longer red (orange, or yellow when the quest has no orange step) and ends at the level
  where it turns **grey**. Data comes from the
  [Every Dungeon Quest](https://www.wowhead.com/forever/guide/dungeons/every-dungeon-quest-location)
  guide plus each quest's *Quick Facts* (difficulty, faction, and whether it's shareable).

For example, [Important Heirlooms](https://www.wowhead.com/forever/quest=96403/important-heirlooms)
is red at 10, orange at 11, and grey at 22, so its bar runs from 11 to 22.

Set your level to color quest names the way the in-game quest log does. By default only
dungeons and quests you can do at your level (or will be able to at the next level) are shown;
untick **Only show my level (+1)** to see everything. **Highlight in-range** is the alternative: it
keeps everything listed but fades what's outside that range, on both the dungeon and quest
timelines. Ticking one unticks the other. You can also filter by faction,
shareable quests, class quests, or new vs. classic dungeons. Every setting is remembered in
your browser.

### Per quest
- **Where it starts**, right next to the quest: town or subzone and map coordinates. Click it
  to copy a `/way` command.
- **Click a quest** for details: pickup NPC, objective, turn-in, rewards, and its **quest chain**.
  Tick off steps as you go; progress shows as `⛓ 2/5` on the row and is saved in your browser.
  Curated chains list only the steps you actually need. Where there isn't one, the chain
  comes from Wowhead's quest series, which can include optional breadcrumbs.
- **Hide completed** removes quests you've marked done.

### Per dungeon (📖)
A quick reference card: entrance location, suggested levels, map with boss and entrance pins
(the four new Forever dungeons), bosses with levels and loot, every quest with its location,
and the cross-faction travel route where one exists.

## Route Planner

The **Route Planner** tab lays out your leveling route on a level axis. Use **Add zone** for a
zone or a custom step and **Add dungeon** for a dungeon, each with a min and max level. Steps can overlap, like a dungeon run in
the middle of a zone. Drag the handles on either side of a step to change its levels, or drag the
step itself to move it. A step whose min and max are the same is a single point.

- **Zone steps** list the dungeon quests that start in the zone and the dungeons in range.
- **Dungeon steps** list the quests to pick up before the run, grouped by where they start.
  Untick quests you'll skip. Name colours show each quest's difficulty at the level you enter.
  A dungeon starts as a single point at its suggested level; drag its handles to stretch it.
  **Add all dungeons** (next to Add dungeon) adds every dungeon not yet in the route this way,
  after a confirmation listing them.
- **Custom steps** are anything else, with your own name.
- **Completing steps**: tick the box at the start of a step to grey it out and strike it through.
- **Warnings**: flags under-leveled dungeons, quests still red or already grey when you get
  there, zones you'll outlevel, and levels nothing in the route covers (shaded).
- **Your level**: the planner's own level slider (it starts at 1), marked on the planner's axis.
  *Zoom to my level* shows the timeline from 3 levels below your level up to 60. *Only show my
  level (+/- 3)* hides route steps more than three levels below or above yours, and *Highlight
  in-range* fades them instead. Either way at least 7 steps stay shown, topped up with the nearest ones; the
  zoom works with either. The level notes list can be collapsed; clicking a note's ⚑ flag on the
  timeline, on a step, or in a step's details jumps to that note.
- **New planners** start empty (apart from the default notes), with no faction, any class, and
  level 1. Click the selected faction again to clear it; with no faction, zone lists and quest
  pickups include both factions. **Reset to default** returns to that; **Clear plan** removes
  every step and note.
- **Level notes**: reminders pinned to a level, like "at 14, the sleeping bag chain begins".
  They stay at that level when steps move. Each note can also have a **quest**, **items**
  (comma-separated) and a YouTube **video**; each takes an ID or a full link, and a video can
  include a start time (`pGR_66uhwSY?t=465`). Quest and item links go to Wowhead. **Links**
  takes any other web addresses, comma-separated. All of these are optional, and **Edit**
  changes any of them.
- **Default notes**: every planner starts with 18 notes, mostly worthwhile questlines from level 2
  to 56 (cooking at 5, Bag of Marbles, the sleeping bag, Linken's Boomerang, the LBRS/UBRS trinkets and more).
  They live in `DEFAULT_NOTES` in `js/planner.js`. To add one, give it `since` set to the next
  `DEFAULTS_VERSION` and bump that; to change one, add its previous values to `was` and bump it.
  Untouched copies update, and notes people edited or deleted are left alone.
- **Share**: *Copy share link* puts the whole route in the URL. Routes are saved in your browser.

## Files

| Path | What |
| --- | --- |
| `index.html`, `css/`, `js/` | The site (static, no build step) |
| `data/dungeons.js` | Dungeon ranges, edited by hand |
| `data/zones.js` | Questing zone ranges for the planner, edited by hand |
| `js/planner.js` | The Route Planner tab |
| `data/quests.js` | Quest data, generated by the refresh script |
| `data/journal.js`, `img/maps/` | Chains, locations, bosses and maps, generated by a local import script |
| `data/instance-maps.js`, `img/maps/` | Classic dungeon maps with boss pins (ForeverInstanceMaps addon), generated by a local import script |
| `scripts/refresh-quests.js` | Re-pulls quest data from Wowhead |

## Refreshing quest data

Forever is in beta, so the numbers will change. Wowhead blocks scripted requests, so the
refresh runs in your browser:

1. Open the [Every Dungeon Quest guide](https://www.wowhead.com/forever/guide/dungeons/every-dungeon-quest-location).
2. Open DevTools (F12), go to **Console**, paste the contents of `scripts/refresh-quests.js`, and press Enter.
3. When it finishes, it downloads `quests.js`. Replace `data/quests.js` with it.

It's throttled to be polite and takes several minutes. If Wowhead rate-limits you, the console
lists the quests it couldn't fetch; wait a few minutes and run it again. Pages it already
fetched are cached for 12 hours, so a rerun only fetches what's missing.

To change dungeon ranges, or to add one, edit `data/dungeons.js`. A new dungeon's `key` must
match a heading in `DUNGEON_FOR_HEADING` in the refresh script.

## Releasing changes

`index.html` loads the CSS and scripts with a version query (`?v=32`). Bump it whenever you change
any of them, so browsers don't mix a cached old file with new ones.

## Run locally

Open `index.html` in a browser. No server is needed.

## Publish on GitHub Pages

Push to `main`, then in the repo go to **Settings → Pages → Build and deployment**, choose
**Deploy from a branch**, and select `main` / `(root)`. The site will be at
`https://addohm.github.io/wow-leveling-timeline/`.

## Credits

Some inspiration was taken from the [DungeonJournal](https://www.curseforge.com/wow/addons/dungeonjournal)
addon for WoW: Forever.

---

Not affiliated with Blizzard Entertainment or Wowhead. World of Warcraft is a trademark of Blizzard Entertainment.
