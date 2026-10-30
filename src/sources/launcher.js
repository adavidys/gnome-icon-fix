// What the launchers (Steam, Heroic, Lutris, Bottles, plain Wine) have in
// common. Each one knows its shortcuts by a key in their Exec= line (a
// Steam app id, a Heroic appName, a Lutris slug, a Bottles program...),
// and works out the key of a running game from its window and process. A
// launcher source says how:
//
//   entryKeys(entry, argv, index) -> [string] | null
//       The keys of a .desktop entry, or null when the entry doesn't run
//       this launcher. May also file it in the index's other tables
//       (index.exec).
//   windowKeys(ctx) -> iterable of strings
//       The keys of a window's game, best first; empty ones are skipped.
//       A generator when later keys cost more to find.
//
// and gets indexEntry() and identify() from here. The rest of the source
// interface (registry.js) stays the launcher's own.

import {guessPaths} from '../lib/matcher.js';
import {canonical, isUnder} from '../lib/util.js';

export class LauncherSource {
    // sandbox: its Flatpak app id; envKeys: see registry.js
    constructor(name, {sandbox = null, envKeys = []} = {}) {
        this.name = name;
        this.sandbox = sandbox;
        this.envKeys = envKeys;
    }

    indexEntry(entry, argv, index) {
        const keys = this.entryKeys(entry, argv, index);
        if (!keys)
            return false;
        const map = index.map(this.name);
        for (const key of keys)
            index.add(map, key, entry.id);
        return true;
    }

    // A shortcut of the window's own flavor (native or the launcher's
    // Flatpak) for any of its keys, else one of the other flavor: a native
    // game mustn't get the Flatpak's shortcut while its own exists.
    identify(ctx, index) {
        const map = index.map(this.name);
        const tried = [];
        for (const key of this.windowKeys(ctx)) {
            const id = index.find(map, key, ctx, true);
            if (id)
                return {id};
            tried.push(key);
        }
        const id = tried.map(key => index.find(map, key, ctx)).find(Boolean);
        return id ? {id} : null;
    }

    // What a source worked out about a window, kept on its context for the
    // source's other calls about it (launched, identify, fallback).
    remember(ctx, key, find) {
        if (ctx[key] === undefined)
            ctx[key] = find();
        return ctx[key];
    }

    // The Wine prefixes the window's process runs in: its WINEPREFIX and
    // Proton's compat data folder, each also without the /pfx Proton (and
    // umu) keep the actual prefix in.
    prefixes(ctx) {
        return this.remember(ctx, 'prefixes', () => [...new Set(
            [ctx.prefix, canonical(ctx.env.STEAM_COMPAT_DATA_PATH)].filter(Boolean)
                .flatMap(p => p.endsWith('/pfx') ? [p, p.slice(0, -4)] : [p]))]);
    }

    // The game ({dir}) whose install folder the window's program runs
    // from, as a guess (guessPaths()), or null. games() is only asked when
    // there is something to go on.
    gameInFolder(ctx, games) {
        const where = guessPaths(ctx, this);
        return where.length ? games().find(g => g.dir && where.some(path => isUnder(path, g.dir))) ?? null : null;
    }
}
