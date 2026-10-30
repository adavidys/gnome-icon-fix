// Plain Wine: menu entries made by winemenubuilder (`env WINEPREFIX=...
// wine start /unix <...>.lnk`) and hand-written ones (`wine C:\...\game.exe`).
// The same .exe name in two prefixes is told apart by the prefix.

import {readLnk} from '../lib/lnk.js';
import {execPrefix, isWineBinary, programFromArgv, wineToHost} from '../lib/process.js';
import {exeStem, normalize} from '../lib/util.js';
import {LauncherSource} from './launcher.js';

// Keys compare normalized ("Foo Bar.exe" and foobar.exe).
function key(prefix, stem) {
    return `${prefix}\n${normalize(stem)}`;
}

export class WineSource extends LauncherSource {
    constructor() {
        super('wine');
    }

    entryKeys(entry, argv, index) {
        const wine = argv.findIndex(isWineBinary);
        const program = wine < 0 ? null : programFromArgv(argv.slice(wine));
        if (!program?.path)
            return null;
        const prefix = execPrefix(argv.slice(0, wine));
        // A shortcut by the program it starts, and by its own name: menu
        // shortcuts are often named like it.
        const file = /\.lnk$/i.test(program.path) ? wineToHost(program.path, prefix) : null;
        const lnk = file ? readLnk(file, prefix) : null;
        const stems = [...new Set([lnk && exeStem(lnk.program), exeStem(program.path)].filter(Boolean))];
        for (const stem of stems)
            index.add(index.exec, stem, entry.id);
        return stems.map(stem => key(prefix, stem));
    }

    windowKeys(ctx) {
        return ctx.prefix ? ctx.stems.map(stem => key(ctx.prefix, stem)) : [];
    }
}
