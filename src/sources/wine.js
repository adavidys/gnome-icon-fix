// Plain Wine: menu entries made by winemenubuilder (`env WINEPREFIX=...
// wine start /unix <...>.lnk`) and hand-written ones (`wine C:\...\game.exe`).
// The same .exe name in two prefixes is told apart by the prefix.

import {isWineBinary, programFromArgv} from '../lib/process.js';
import {canonical, exeStem, home, normalize} from '../lib/util.js';

export class WineSource {
    constructor() {
        this.name = 'wine';
    }

    indexEntry(entry, argv, index) {
        const wine = argv.findIndex(isWineBinary);
        if (wine < 0)
            return false;
        const program = programFromArgv(argv.slice(wine));
        if (!program?.path)
            return false;
        const assigned = argv.slice(0, wine)
            .map(arg => arg.match(/^WINEPREFIX=(.+)$/)?.[1])
            .find(Boolean);
        const prefix = canonical(assigned) ?? home('.wine');
        // A .lnk is usually named after the program, not after its .exe:
        // compare normalized ("Foo Bar.lnk" and foobar.exe).
        const stem = exeStem(program.path);
        index.add(index.map('wine'), `${prefix}\n${normalize(stem)}`, entry.id);
        index.add(index.exec, stem, entry.id);
        return true;
    }

    identify(ctx, index) {
        if (!ctx.prefix)
            return null;
        const map = index.map('wine');
        for (const stem of ctx.stems) {
            const id = index.find(map, `${ctx.prefix}\n${normalize(stem)}`, ctx);
            if (id)
                return {id};
        }
        return null;
    }
}
