// Last resort for Wine programs: the icon and product name inside the
// .exe itself (see lib/peicon.js). Covers games no launcher made an icon
// for: Heroic sideloads, Flatpak Bottles, Lutris without its icon, plain
// `wine game.exe`.

import {exeIcon, exeInfo} from '../lib/peicon.js';
import {execPrefix, programFromArgv, wineToHost} from '../lib/process.js';
import {basename, exists, stripExt} from '../lib/util.js';

export class ExeSource {
    constructor() {
        this.name = 'exe';
    }

    // `[env WINEPREFIX=...] wine C:\\Games\\game.exe`, `wine /path/game.exe`,
    // `wine start /unix /path/Game.lnk`
    entryIcon(_entry, argv) {
        const program = programFromArgv(argv)?.path;
        if (!program || !/\.(exe|lnk)$/i.test(program))
            return null;
        return exeIcon(wineToHost(program, execPrefix(argv)));
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
