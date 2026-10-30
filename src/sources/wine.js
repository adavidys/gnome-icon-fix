// Plain Wine: menu entries made by winemenubuilder (`env WINEPREFIX=...
// wine start /unix <...>.lnk`) and hand-written ones (`wine C:\...\game.exe`).
// The same .exe name in two prefixes is told apart by the prefix.

import {execPrefix, isWineBinary, programFromArgv} from '../lib/process.js';
import {exeStem, normalize} from '../lib/util.js';
import {LauncherSource} from './launcher.js';

// A .lnk is usually named after the program, not after its .exe: keys
// compare normalized ("Foo Bar.lnk" and foobar.exe).
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
        const stem = exeStem(program.path);
        index.add(index.exec, stem, entry.id);
        return [key(execPrefix(argv.slice(0, wine)), stem)];
    }

    windowKeys(ctx) {
        return ctx.prefix ? ctx.stems.map(stem => key(ctx.prefix, stem)) : [];
    }
}
