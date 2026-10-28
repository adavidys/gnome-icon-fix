// Last resort for Wine programs: the icon and product name inside the
// .exe itself (see lib/peicon.js). Covers games no launcher made an icon
// for: Heroic sideloads, Flatpak Bottles, Lutris without its icon, plain
// `wine game.exe`.

import {exeInfo} from '../lib/peicon.js';
import {programFromArgv, wineToHost} from '../lib/process.js';
import {basename, canonical, exists, home, stripExt} from '../lib/util.js';

export class ExeSource {
    constructor() {
        this.name = 'exe';
    }

    // `[env WINEPREFIX=...] wine C:\\Games\\game.exe`, `wine /path/game.exe`
    entryIcon(_entry, argv) {
        const program = programFromArgv(argv)?.path;
        if (!program || !/\.exe$/i.test(program))
            return null;
        const prefix = canonical(argv.map(arg => arg.match(/^WINEPREFIX=(.+)$/)?.[1]).find(Boolean)) ??
            home('.wine');
        const path = wineToHost(program, prefix);
        return path && exists(path) ? exeInfo(path)?.icon ?? null : null;
    }

    fallback(ctx) {
        if (!ctx.wine)
            return null;
        const path = this._exe(ctx);
        const info = path && exeInfo(path);
        if (!info)
            return null;
        // Without a product name, the file name is still better than the
        // launcher's ("Hollow Knight Silksong.exe" -> "Hollow Knight Silksong").
        return {icon: info.icon, name: info.name ?? stripExt(basename(path))};
    }

    // The .exe the process has mapped comes first in ctx.paths.
    _exe(ctx) {
        return ctx.paths.find(p => /\.exe$/i.test(p) && exists(p)) ?? null;
    }
}
