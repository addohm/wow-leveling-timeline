<#
.SYNOPSIS
  Imports DungeonJournal (ForeverDungeonJournal addon) data into the site.

.DESCRIPTION
  Reads the addon's Lua data tables and writes data/journal.js:
    - quest chains (required-to-unlock steps) and step details
    - quest-giver map coordinates
    - dungeon bosses, boss levels, loot, entrances and travel routes
    - dungeon map layouts (boss pins, entrance, floor transitions)
  Custom dungeon map textures (TGA) are converted to JPEG in img/maps/.

  Run it again whenever the addon is updated:
    pwsh scripts/import-addon.ps1
    pwsh scripts/import-addon.ps1 -AddonPath "D:\Games\WoW\_classic_beta_\Interface\AddOns\ForeverDungeonJournal"
#>
param(
  [string]$AddonPath = 'C:\Program Files (x86)\World of Warcraft\_classic_beta_\Interface\AddOns\ForeverDungeonJournal',
  [int]$MaxMapWidth = 1600
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$AddonPath\ForeverDungeonJournal.toc")) { throw "Addon not found at $AddonPath" }

$refs = 'System.Runtime', 'System.Collections', 'System.Text.RegularExpressions', 'System.Runtime.InteropServices',
         'System.Runtime.Extensions', 'System.Private.Uri', 'System.Drawing.Common', 'System.Drawing.Primitives', 'System.ComponentModel.Primitives'
# Newer PowerShell builds split System.Drawing across an extra assembly; reference it when present.
$refs += [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq 'System.Private.Windows.Core' } | ForEach-Object Location
if (-not ($refs -match 'Windows\.Core')) {
  $core = Join-Path ([System.IO.Path]::GetDirectoryName([object].Assembly.Location)) 'System.Private.Windows.Core.dll'
  if (Test-Path $core) { $refs += $core }
}
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

// Minimal parser for Lua table literals, as used in the addon's data files.
// Handles nested tables, strings, numbers, booleans, simple arithmetic
// (683 / 1024) and string concatenation. Identifiers resolve from `Consts`;
// anything else (function calls, unknown names) becomes null.
public class LuaData {
  string s; int p;
  public Dictionary<string, object> Consts = new Dictionary<string, object>();

  public Dictionary<string, object> ParseFile(string text) {
    var result = new Dictionary<string, object>();
    s = text;
    var re = new Regex(@"(?m)^(?:local\s+)?((?:FDJ\.)?[A-Za-z_]\w*(?:\[""[^""]+""\])?)\s*=\s*\{");
    foreach (Match m in re.Matches(text)) {
      p = m.Index + m.Length - 1;
      try {
        var name = m.Groups[1].Value;
        if (name.StartsWith("FDJ.")) name = name.Substring(4);
        result[name] = ParseValue();
      } catch (Exception) { /* not a plain data table */ }
    }
    return result;
  }

  void Ws() {
    while (p < s.Length) {
      char c = s[p];
      if (char.IsWhiteSpace(c)) { p++; continue; }
      if (c == '-' && p + 1 < s.Length && s[p + 1] == '-') {
        p += 2;
        if (p + 1 < s.Length && s[p] == '[' && s[p + 1] == '[') { int e = s.IndexOf("]]", p); p = e < 0 ? s.Length : e + 2; }
        else { int e = s.IndexOf('\n', p); p = e < 0 ? s.Length : e + 1; }
        continue;
      }
      break;
    }
  }

  object ParseValue() {
    object v = ParseAtom();
    while (true) {
      Ws();
      if (p + 1 < s.Length && s[p] == '.' && s[p + 1] == '.') { p += 2; Ws(); var r = ParseAtom(); v = Convert.ToString(v, CultureInfo.InvariantCulture) + Convert.ToString(r, CultureInfo.InvariantCulture); continue; }
      if (p < s.Length && "*/+".IndexOf(s[p]) >= 0 || (p < s.Length && s[p] == '-' && !(p + 1 < s.Length && s[p + 1] == '-'))) {
        char op = s[p++]; Ws(); var r = ParseAtom();
        if (v is double a && r is double b) v = op == '*' ? a * b : op == '/' ? a / b : op == '+' ? a + b : a - b;
        else v = null;
        continue;
      }
      return v;
    }
  }

  object ParseAtom() {
    Ws();
    char c = s[p];
    if (c == '{') return ParseTable();
    if (c == '"' || c == '\'') return ParseString(c);
    if (c == '[' && p + 1 < s.Length && (s[p + 1] == '[' || s[p + 1] == '=')) return ParseLongString();
    if (char.IsDigit(c) || c == '.' || (c == '-' && p + 1 < s.Length && (char.IsDigit(s[p + 1]) || s[p + 1] == '.'))) return ParseNumber();
    if (c == '(') { p++; var v = ParseValue(); Ws(); if (s[p] == ')') p++; return v; }
    if (char.IsLetter(c) || c == '_') {
      int start = p;
      while (p < s.Length && (char.IsLetterOrDigit(s[p]) || s[p] == '_' || s[p] == '.' && !(p + 1 < s.Length && s[p + 1] == '.'))) p++;
      string id = s.Substring(start, p - start);
      if (id == "true") return true;
      if (id == "false") return false;
      if (id == "nil") return null;
      Ws();
      if (p < s.Length && (s[p] == '(' || s[p] == '[')) { SkipBalanced(); return null; }
      string last = id.Substring(id.LastIndexOf('.') + 1);
      return Consts.ContainsKey(last) ? Consts[last] : null;
    }
    throw new Exception("Unexpected '" + c + "' at " + p);
  }

  void SkipBalanced() {
    char open = s[p], close = open == '(' ? ')' : ']';
    int depth = 0;
    for (; p < s.Length; p++) {
      if (s[p] == '"' || s[p] == '\'') { ParseString(s[p]); p--; continue; }
      if (s[p] == open) depth++;
      else if (s[p] == close && --depth == 0) { p++; return; }
    }
  }

  object ParseNumber() {
    int start = p;
    if (s[p] == '-') p++;
    if (p + 1 < s.Length && s[p] == '0' && (s[p + 1] == 'x' || s[p + 1] == 'X')) {
      p += 2; int hs = p; while (p < s.Length && Uri.IsHexDigit(s[p])) p++;
      return (double)Convert.ToInt64(s.Substring(hs, p - hs), 16) * (s[start] == '-' ? -1 : 1);
    }
    while (p < s.Length && (char.IsDigit(s[p]) || s[p] == '.' || s[p] == 'e' || s[p] == 'E' || ((s[p] == '-' || s[p] == '+') && (s[p - 1] == 'e' || s[p - 1] == 'E')))) p++;
    return double.Parse(s.Substring(start, p - start), CultureInfo.InvariantCulture);
  }

  string ParseString(char q) {
    p++;
    var sb = new StringBuilder();
    while (s[p] != q) {
      char c = s[p++];
      if (c == '\\') {
        char e = s[p++];
        switch (e) {
          case 'n': sb.Append('\n'); break;
          case 't': sb.Append('\t'); break;
          case 'r': break;
          case '\n': sb.Append('\n'); break;
          default:
            if (char.IsDigit(e)) {
              int st = p - 1; while (p < s.Length && p - st < 3 && char.IsDigit(s[p])) p++;
              sb.Append((char)int.Parse(s.Substring(st, p - st)));
            } else sb.Append(e);
            break;
        }
      } else sb.Append(c);
    }
    p++;
    return sb.ToString();
  }

  string ParseLongString() {
    int eq = 0; p++;
    while (s[p] == '=') { eq++; p++; }
    p++;
    string close = "]" + new string('=', eq) + "]";
    int e = s.IndexOf(close, p);
    string v = s.Substring(p, e - p);
    p = e + close.Length;
    return v.StartsWith("\n") ? v.Substring(1) : v;
  }

  object ParseTable() {
    p++;
    var dict = new Dictionary<string, object>();
    var list = new List<object>();
    bool keyed = false;
    while (true) {
      Ws();
      if (s[p] == '}') { p++; break; }
      if (s[p] == '[' && s[p + 1] != '[' && s[p + 1] != '=') {
        p++; var k = ParseValue(); Ws(); p++; Ws(); p++;
        var v = ParseValue();
        dict[Convert.ToString(k, CultureInfo.InvariantCulture)] = v; keyed = true;
      } else {
        int save = p;
        var m = Regex.Match(s.Substring(p, Math.Min(80, s.Length - p)), @"^([A-Za-z_]\w*)\s*=(?!=)");
        if (m.Success) { p += m.Length; var v = ParseValue(); dict[m.Groups[1].Value] = v; keyed = true; }
        else { p = save; list.Add(ParseValue()); }
      }
      Ws();
      if (s[p] == ',' || s[p] == ';') p++;
    }
    if (!keyed) return list;
    for (int i = 0; i < list.Count; i++) dict[(i + 1).ToString()] = list[i];
    return dict;
  }
}

// Decodes 24/32-bit TGA (raw or RLE) and saves a cropped, scaled JPEG.
public static class Tga {
  public static int[] Convert(string src, string dst, double right, double bottom, int maxWidth) {
    byte[] d = System.IO.File.ReadAllBytes(src);
    int idLen = d[0], type = d[2], w = d[12] | d[13] << 8, h = d[14] | d[15] << 8, bpp = d[16] / 8;
    bool topDown = (d[17] & 0x20) != 0;
    int cmapLen = (d[5] | d[6] << 8) * ((d[7] + 7) / 8);
    int pos = 18 + idLen + cmapLen;
    var px = new byte[w * h * 4];
    int n = 0, total = w * h;
    Action<int> put = o => { px[n * 4] = d[o]; px[n * 4 + 1] = d[o + 1]; px[n * 4 + 2] = d[o + 2]; px[n * 4 + 3] = bpp == 4 ? d[o + 3] : (byte)255; n++; };
    if (type == 2) { while (n < total) { put(pos); pos += bpp; } }
    else if (type == 10) {
      while (n < total) {
        int hdr = d[pos++], count = (hdr & 0x7f) + 1;
        if ((hdr & 0x80) != 0) { for (int i = 0; i < count && n < total; i++) put(pos); pos += bpp; }
        else { for (int i = 0; i < count && n < total; i++) { put(pos); pos += bpp; } }
      }
    } else throw new Exception("Unsupported TGA type " + type + " in " + src);

    int cw = (int)Math.Round(w * right), ch = (int)Math.Round(h * bottom);
    using (var bmp = new System.Drawing.Bitmap(cw, ch, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
      var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, cw, ch), System.Drawing.Imaging.ImageLockMode.WriteOnly, bmp.PixelFormat);
      var row = new byte[cw * 4];
      for (int y = 0; y < ch; y++) {
        int sy = topDown ? y : h - 1 - y;
        for (int x = 0; x < cw; x++) {
          int si = (sy * w + x) * 4, a = px[si + 3];
          // Flatten onto dark parchment so transparent edges don't turn black/white in JPEG.
          row[x * 4] = (byte)((px[si] * a + 0x10 * (255 - a)) / 255);
          row[x * 4 + 1] = (byte)((px[si + 1] * a + 0x15 * (255 - a)) / 255);
          row[x * 4 + 2] = (byte)((px[si + 2] * a + 0x1d * (255 - a)) / 255);
          row[x * 4 + 3] = 255;
        }
        System.Runtime.InteropServices.Marshal.Copy(row, 0, data.Scan0 + y * data.Stride, row.Length);
      }
      bmp.UnlockBits(data);
      int ow = Math.Min(cw, maxWidth), oh = (int)Math.Round(ch * (double)ow / cw);
      using (var outBmp = new System.Drawing.Bitmap(ow, oh))
      using (var g = System.Drawing.Graphics.FromImage(outBmp)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.DrawImage(bmp, 0, 0, ow, oh);
        var enc = Array.Find(System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders(), e => e.MimeType == "image/jpeg");
        var ps = new System.Drawing.Imaging.EncoderParameters(1);
        ps.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 84L);
        outBmp.Save(dst, enc, ps);
      }
      return new[] { ow, oh };
    }
  }
}
'@

# ---------- Parse every data file ----------
$lua = [LuaData]::new()
$lua.Consts['ALBA_FAIRMOON_LOCATION'] = 'Alba Fairmoon, Sentinel Hill inn, Westfall'
$boot = Get-Content -Raw "$AddonPath\Core\Bootstrap.lua"
foreach ($m in [regex]::Matches($boot, 'FDJ\.Constants\.(\w+)\s*=\s*"([^"]*)"')) { $lua.Consts[$m.Groups[1].Value] = $m.Groups[2].Value }

$T = @{}
foreach ($f in 'Data\Dungeons.lua', 'Data\QuestChains.lua', 'Data\QuestMaps.lua', 'Data\Bosses.lua',
               'Data\DungeonEntrances.lua', 'Data\DungeonRoutes.lua', 'Core\Journal.lua') {
  $parsed = $lua.ParseFile((Get-Content -Raw "$AddonPath\$f"))
  foreach ($k in $parsed.Keys) { $T["$f|$k"] = $parsed[$k] }
}
function Get-Table($file, $name) { $T["$file|$name"] }

# Dungeons are defined as FDJ.DB = { ... } plus DB["Name"] = { ... } additions.
$db = [ordered]@{}
$base = Get-Table 'Data\Dungeons.lua' 'DB'
foreach ($k in $base.Keys) { $db[$k] = $base[$k] }
foreach ($key in $T.Keys) {
  if ($key -match '^Data\\Dungeons\.lua\|(?:FDJ\.)?DB\["(.+)"\]$') { $db[$Matches[1]] = $T[$key] }
}

# Addon dungeon names -> site keys (data/dungeons.js).
$siteKey = @{
  'Hall of Thanes' = 'hot'; 'Wailing Caverns' = 'wc'; 'Ruins of Lordaeron' = 'rol'; 'The Deadmines' = 'dm';
  'Blackfathom Deeps' = 'bfd'; 'Ragefire Chasm' = 'rfc'; 'Shadowfang Keep' = 'sfk'; 'The Stockade' = 'stocks';
  'Excavation Site: Wetlands' = 'exc'; 'City of Dalaran' = 'dal'; 'Gnomeregan' = 'gnomer'; 'Razorfen Kraul' = 'rfk';
  'Scarlet Monastery: Graveyard' = 'sm';
}

function Num($v) { if ($null -eq $v) { $null } else { [math]::Round([double]$v, 4) } }
function MapPoint($m) {
  if (-not $m -or -not $m['mapID']) { return $null }
  [ordered]@{ mapID = [int]$m['mapID']; x = Num(([double]$m['x']) * 100); y = Num(([double]$m['y']) * 100); label = $m['label']; detail = $m['detail'] }
}
function ItemRef($i) { if ($i -is [System.Collections.IList]) { [ordered]@{ id = $i[0]; name = $i[1]; quality = $i[2]; source = $i[3] } } }

# ---------- Quests (addon view) ----------
$questMaps = Get-Table 'Data\QuestMaps.lua' 'QUEST_START_MAPS'
$quests = [ordered]@{}
foreach ($dn in $db.Keys) {
  foreach ($q in @($db[$dn]['quests'])) {
    if (-not $q -or -not $q['id']) { continue }
    $id = [string][int]$q['id']
    $quests[$id] = [ordered]@{
      id = [int]$q['id']; name = $q['name']; dungeon = $siteKey[$dn]; faction = $q['faction']
      level = $q['level']; requires = $q['requires']
      pickup = $q['pickup']; turnin = $q['turnin']; objective = $q['objective']; note = $q['note']
      rewards = $q['rewards']
      startMap = MapPoint($(if ($q['startMap']) { $q['startMap'] } else { $questMaps[$id] }))
      noteMap = MapPoint($q['noteItemMap'])
      startItem = ItemRef($q['startItem'])
      classOnly = $q['classOnly']
    }
  }
}
foreach ($id in $questMaps.Keys) {
  if (-not $quests.Contains($id)) { $quests[$id] = [ordered]@{ id = [int]$id; startMap = MapPoint($questMaps[$id]) } }
}

# ---------- Chains ----------
$chainsRaw = Get-Table 'Data\QuestChains.lua' 'QUEST_PREREQ_CHAINS'
$details = Get-Table 'Data\QuestChains.lua' 'QUEST_PREREQ_DETAILS'
$chains = [ordered]@{}
foreach ($id in $chainsRaw.Keys) {
  $chains[$id] = @($chainsRaw[$id] | ForEach-Object {
    $sid = [string][int]$_['id']; $d = $details[$sid]
    [ordered]@{
      id = [int]$_['id']; name = $_['name']; itemStep = [bool]$_['itemStep']
      level = $d['level']; requires = $d['requires']; objective = $d['objective']
      pickup = $d['pickup']; turnin = $d['turnin']; description = $d['description']; note = $d['note']
      map = MapPoint($d['map']); startItem = ItemRef($d['startItem'])
    }
  })
}

# ---------- Dungeons: bosses, entrances, routes, maps ----------
$bossLevels = Get-Table 'Data\Bosses.lua' 'BOSS_LEVELS'
$entrances = Get-Table 'Data\DungeonEntrances.lua' 'entrances'
$routes = Get-Table 'Data\DungeonRoutes.lua' 'routes'
$mapDefs = Get-Table 'Core\Journal.lua' 'DUNGEON_MAPS'
$mapOut = Join-Path $root 'img\maps'
New-Item -ItemType Directory -Force $mapOut | Out-Null

$dungeons = [ordered]@{}
foreach ($dn in $db.Keys) {
  $key = $siteKey[$dn]
  if (-not $key) { Write-Warning "No site key for addon dungeon '$dn' - add it to `$siteKey"; continue }
  $d = $db[$dn]
  $levels = $bossLevels[$dn]
  $bosses = @($d['bosses'] | Where-Object { $_ } | ForEach-Object {
    [ordered]@{
      name = $_['name']; npcID = $_['npcID']; level = $levels[$_['name']]
      loot = @($_['loot'] | Where-Object { $_ -is [System.Collections.IList] } | ForEach-Object { [ordered]@{ id = $_[0]; name = $_[1]; slot = $_[2]; quality = $_[3] } })
    }
  })

  $route = $null
  if ($routes[$dn]) {
    $en = $routes[$dn]['locales']['enUS']
    $route = [ordered]@{
      faction = $routes[$dn]['faction']; title = $en['title']
      steps = @($en['steps'] | ForEach-Object { [ordered]@{ title = $_['title']; text = $_['text']; map = MapPoint($_['map']) } })
    }
  }

  $map = $null
  $md = $mapDefs[$dn]
  if ($md -and @($md['floors'] | Where-Object { $_['texture'] }).Count) {
    $floors = @()
    $i = 0
    foreach ($fl in $md['floors']) {
      $i++
      if (-not $fl['texture']) { $floors += $null; continue }
      $tex = ($fl['texture'] -split '\\')[-1]
      $file = "$tex.jpg"
      $right = if ($fl['texRight']) { [double]$fl['texRight'] } else { 1 }
      $bottom = if ($fl['texBottom']) { [double]$fl['texBottom'] } else { 1 }
      $size = [Tga]::Convert("$AddonPath\Media\$tex.tga", (Join-Path $mapOut $file), $right, $bottom, $MaxMapWidth)
      Write-Host "  map $file ($($size[0])x$($size[1]))"
      $floors += [ordered]@{ image = "img/maps/$file"; width = $size[0]; height = $size[1] }
    }
    $pt = { param($o) [ordered]@{ floor = $(if ($o['floor']) { [int]$o['floor'] } else { 1 }); x = Num($o['x']); y = Num($o['y']) } }
    $map = [ordered]@{
      floors = $floors
      entrance = $(if ($md['entrance']) { $e = & $pt $md['entrance']; $e['angle'] = $md['entrance']['angle']; $e })
      bosses = @($md['bosses'] | ForEach-Object { $b = & $pt $_; $b['name'] = $_['name']; $b })
      transitions = @($md['transitions'] | Where-Object { $_ } | ForEach-Object { $t = & $pt $_; $t['to'] = [int]$_['to']; $t })
    }
  } elseif ($md) {
    # Classic dungeon: the addon draws the game's own map tiles, which aren't shipped with it.
    $map = [ordered]@{ floors = @(); clientTiles = $true
      bosses = @($md['bosses'] | ForEach-Object { [ordered]@{ name = $_['name']; floor = $(if ($_['floor']) { [int]$_['floor'] } else { 1 }) } }) }
  }

  $dungeons[$key] = [ordered]@{
    name = $dn; level = $d['level']; location = $d['location']; description = $d['description']
    entrance = MapPoint($entrances[$dn]); route = $route; bosses = $bosses; map = $map
  }
}

# ---------- Write ----------
$toc = Get-Content "$AddonPath\ForeverDungeonJournal.toc"
$version = ($toc | Select-String '^## Version:\s*(.+)$').Matches[0].Groups[1].Value
$out = [ordered]@{
  source = "DungeonJournal $version"; imported = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  quests = $quests; chains = $chains; dungeons = $dungeons
}
$json = $out | ConvertTo-Json -Depth 12 -Compress
$js = "// Generated by scripts/import-addon.ps1 from the DungeonJournal addon - do not edit by hand.`nwindow.FOREVER_JOURNAL = $json;`n"
[System.IO.File]::WriteAllText((Join-Path $root 'data\journal.js'), $js, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote data/journal.js: $($quests.Count) quests, $($chains.Count) chains, $($dungeons.Count) dungeons (DungeonJournal $version)"
