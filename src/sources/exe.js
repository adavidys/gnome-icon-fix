// Last resort for Wine programs: the icon and product name inside the
// .exe itself (see lib/peicon.js). Covers games no launcher made an icon
// for: Heroic sideloads, Flatpak Bottles, Lutris without its icon, plain
// `wine game.exe`.

import {exeInfo} from '../lib/peicon.js';
import {programFromArgv} from '../lib/process.js';
import {basename, canonical, exists, stripExt} from '../lib/util.js';

export class ExeSource {
    constructor() {
        this.name = 'exe';
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

    _exe(ctx) {
        const found = ctx.paths.find(p => /\.exe$/i.test(p) && exists(p));
        if (found)
            return found;
        // Drives other than Z: may not resolve (umu maps the game folder to
        // its own letter); games usually run from their own folder.
        const program = programFromArgv(ctx.proc.argv)?.path;
        if (!program || !ctx.cwd || !/\.exe$/i.test(program))
            return null;
        const guess = canonical(`${ctx.cwd}/${basename(program)}`);
        return exists(guess) ? guess : null;
    }
}
