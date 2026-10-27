// Every launcher and packaging system Icon Fix knows about, strongest
// signals first.
//
// A source is an object with a `name` and any of:
//
//   envKeys: [string]
//       Environment variables of a window's process it wants to see
//       (ctx.env). WINEPREFIX is always read.
//   indexEntry(entry, argv, index) -> boolean
//       Called for every .desktop entry whenever the index is rebuilt, which
//       happens often: must not touch the disk. Returns true when the entry
//       is one of this source's launchers, so its Exec isn't also indexed
//       as a plain program. Sources keep their keys in index.map(name).
//   identify(ctx, index) -> {id} | null
//       The desktop entry of a window (ctx: see windowContext() in
//       lib/matcher.js), from exact signals only.
//   sandbox: string
//       The launcher's Flatpak app id: windows from that sandbox were
//       started by it.
//   launched(ctx) -> boolean
//       Whether this launcher started the window's process, from other
//       exact signals (its environment variables, a Wine prefix it made).
//       The matcher keeps one launcher's guesses from claiming a game
//       another one started (ctx.launcher; guessPaths() in lib/matcher.js).
//   entryIcon(entry, argv) -> string | null
//       An icon file for a desktop entry of this source's whose own icon
//       can't be shown (none given, or missing), typically taken from the
//       game it launches. May read the disk; only asked when needed.
//   fallback(ctx, index) -> {iconName?, icon?, name?} | null
//       What to show when no entry matched at all: a themed icon name, an
//       icon file, a display name. Missing icons are skipped by the caller.
//
// Sources live while the extension is enabled and cache what they read
// from disk until the file changes (StampCache in lib/util.js).

import {BottlesSource} from './bottles.js';
import {ExeSource} from './exe.js';
import {HeroicSource} from './heroic.js';
import {LutrisSource} from './lutris.js';
import {PackagingSource} from './packaging.js';
import {SteamSource} from './steam.js';
import {WineSource} from './wine.js';

export function createSources() {
    return [
        // Before Steam: a Heroic game may also carry a Steam id via umu.
        new HeroicSource(),
        new SteamSource(),
        new BottlesSource(),
        new LutrisSource(),
        new WineSource(),
        new PackagingSource(),
        // Fallback only: whatever the launchers know comes first.
        new ExeSource(),
    ];
}

export function envKeys(sources) {
    return new Set(['WINEPREFIX', ...sources.flatMap(s => s.envKeys ?? [])]);
}
