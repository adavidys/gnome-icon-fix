// Everything that tells Icon Fix what a window is, strongest signals first.
//
// A source is an object with a `name` and any of:
//
//   envKeys: [string]
//       Environment variables of a window's process it wants to see
//       (ctx.env). WINEPREFIX is always read.
//   indexEntry(entry, argv, index) -> boolean
//       Called for every .desktop entry whenever the index is rebuilt, which
//       happens often: must not touch the disk. Returns true when the entry
//       is one of this source's launchers' shortcuts, so its Exec isn't
//       also indexed as a plain program. Sources keep their own tables in
//       index.map(name).
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
// The launchers are all one kind of source (launcher.js), each made from
// its description in launchers.js. The others look at any program: the
// app bundle it runs from, an icon named after it, its .exe's icon.
//
// Sources live while the extension is enabled and cache what they read
// from disk until the file changes (StampCache in lib/util.js).

import {LAUNCHERS} from '../launchers.js';
import {ExeSource} from './exe.js';
import {LauncherSource} from './launcher.js';
import {PackagingSource} from './packaging.js';
import {ThemeSource} from './theme.js';

export function createSources() {
    return [
        ...LAUNCHERS.map(desc => new LauncherSource(desc)),
        new PackagingSource(),
        // Fallbacks only: whatever the launchers know comes first, then an
        // icon named after the window, then the .exe's.
        new ThemeSource(),
        new ExeSource(),
    ];
}

export function envKeys(sources) {
    return new Set(['WINEPREFIX', ...sources.flatMap(s => s.envKeys ?? [])]);
}
