// Lookup tables over the installed .desktop entries. Built every time the
// installed apps change (in bursts while Steam installs a game), so building
// only parses the entries and never touches the disk; sources that need
// their launcher's files read them later, when a window has to be matched.

import GLib from 'gi://GLib';

import {readLnk} from './lnk.js';
import * as log from './log.js';
import {execPrefix, isWineBinary, programFromArgv, wineToHost} from './process.js';
import {canonical, exeStem, isSpecificDir, normalize, pathKey, selfAndParents, stripExt} from './util.js';

// Calls an optional source method; a broken source must not take the
// others down with it.
export function tryCall(source, method, ...args) {
    const fn = source[method];
    if (typeof fn !== 'function')
        return null;
    try {
        return fn.apply(source, args) ?? null;
    } catch (e) {
        log.error(`${source.name}.${method}`, e);
        return null;
    }
}

// What runs an entry's launcher: the Flatpak app id (lowercased) when Exec
// goes through `flatpak run`, 'native' otherwise.
export const NATIVE = 'native';

// The flavor a window's process comes from, to compare with an entry's.
export function flavorOf(ctx) {
    return ctx.launcherSandbox?.toLowerCase() ?? NATIVE;
}

// A Windows program in a Wine prefix, as index.wine knows it ("Foo Bar.exe"
// and foobar.exe alike).
export function wineKey(prefix, stem) {
    return `${prefix}\n${normalize(stem)}`;
}

// Exec= -> argv, field codes (%u, %f...) dropped; [] if it can't be parsed.
export function parseExec(exec) {
    if (!exec)
        return [];
    try {
        return GLib.shell_parse_argv(exec.replace(/%[a-zA-Z]/g, ''))[1];
    } catch {
        return [];
    }
}

// Entries that only stand for something else: a URI handler a program
// registers for itself (osu! for Discord: "Game 1216669957799018608",
// hidden, no icon), and anything run from an AppImage's temporary mount,
// gone when it quits.
function notAnApp(e) {
    const types = (e.mimeType ?? '').split(';').filter(Boolean);
    if (e.noDisplay && types.length && types.every(t => t.startsWith('x-scheme-handler/')))
        return true;
    return /(^|[\s"'])\/tmp\/\.mount_[^/\s]+\//.test(e.exec ?? '');
}

export class AppIndex {
    // entries: [{id, name, wmClass, exec, icon, path, noDisplay, mimeType}]
    // (strings, may be null; noDisplay a boolean)
    // sources: see sources/registry.js
    constructor(entries, sources = []) {
        this.wmClass = new Map();
        this.id = new Map();
        this.exec = new Map();
        this.icon = new Map();
        this.name = new Map();
        // Host path of the program in Exec= -> id
        this.path = new Map();
        // id -> host path of the program in Exec=, as it is spelled
        this.program = new Map();
        // Install folder (the program's folder, or Path=) -> id
        this.dir = new Map();
        // id -> name of the source whose launcher the entry runs
        this.owner = new Map();
        // id -> what runs it: the Flatpak app id its Exec= goes through
        // (lowercased), or 'native'
        this.flavor = new Map();
        // Wine prefix and program name -> id (wineKey()); ids of entries
        // that run a Windows program
        this.wine = new Map();
        this.windows = new Set();
        // Tables the sources keep for themselves, see map()
        this._maps = new Map();
        this._sourceMaps = new Set();
        // The flavor of the entry being indexed, see add()
        this._flavor = null;

        // Folders shared by several entries (~/Games/run-foo.sh and
        // run-bar.sh) say nothing, so count first and keep unique ones.
        const dirs = new Map();
        const noteDir = (dir, id) => {
            if (!dir)
                return;
            if (!dirs.has(dir))
                dirs.set(dir, new Set());
            dirs.get(dir).add(id);
        };

        for (const e of entries) {
            if (notAnApp(e))
                continue;
            const id = e.id;
            const shortId = id.replace(/\.desktop$/, '').toLowerCase();
            this.add(this.id, shortId, id);
            this.add(this.id, shortId.split('.').pop(), id);
            this.add(this.wmClass, e.wmClass?.toLowerCase(), id);
            this.add(this.name, normalize(e.name), id);
            if (e.icon && !e.icon.startsWith('/'))
                this.add(this.icon, e.icon.toLowerCase(), id);

            const argv = parseExec(e.exec);
            const program = programFromArgv(argv);
            this._flavor = program?.flatpak ?? NATIVE;
            this.flavor.set(id, this._flavor);

            // Every source sees every entry (Steam also indexes Icon=), any
            // of them can claim it as its launcher.
            let claimed = false;
            for (const source of sources) {
                if (tryCall(source, 'indexEntry', e, argv, this) && !claimed) {
                    claimed = true;
                    this.owner.set(id, source.name);
                }
            }

            // A program run through Wine (menu entries winemenubuilder
            // makes, `wine C:\\...\\game.exe`): known by its prefix and name.
            if (!claimed && this._indexWine(argv, id))
                claimed = true;

            if (!claimed) {
                if (program?.flatpak) {
                    this.add(this.exec, program.flatpak, id);
                } else if (program?.path) {
                    this.add(this.exec, exeStem(program.path), id);
                    const path = canonical(program.path);
                    if (path) {
                        this.add(this.path, pathKey(path), id);
                        this.program.set(id, path);
                        noteDir(path.slice(0, path.lastIndexOf('/')), id);
                    }
                }
            }
            noteDir(canonical(e.path), id);
        }

        this._flavor = null;

        dirs.forEach((ids, dir) => {
            if (ids.size === 1 && isSpecificDir(dir))
                this.dir.set(pathKey(dir), ids.values().next().value);
        });
    }

    // Indexes an entry that runs a Windows program through Wine by its
    // prefix and the program's name, and by the name alone (index.exec);
    // a shortcut (.lnk) by the program it starts and by its own name, as
    // menu shortcuts are often named like their program. Whether it did.
    _indexWine(argv, id) {
        const wine = argv.findIndex(isWineBinary);
        const program = wine < 0 ? null : programFromArgv(argv.slice(wine));
        if (!program?.path)
            return false;
        const prefix = execPrefix(argv.slice(0, wine));
        const file = /\.lnk$/i.test(program.path) ? wineToHost(program.path, prefix) : null;
        const lnk = file ? readLnk(file, prefix) : null;
        for (const stem of new Set([lnk && exeStem(lnk.program), exeStem(program.path)].filter(Boolean))) {
            this.add(this.exec, stem, id);
            this.add(this.wine, wineKey(prefix, stem), id);
        }
        this.windows.add(id);
        return true;
    }

    // A table of the given name, for a source's own keys.
    map(name) {
        let map = this._maps.get(name);
        if (!map) {
            map = new Map();
            this._maps.set(name, map);
            this._sourceMaps.add(map);
        }
        return map;
    }

    // The first entry for a key wins. In the sources' tables, each key is
    // also kept per flavor: native and Flatpak versions of a launcher may
    // both have a shortcut for the same game.
    add(map, key, id) {
        if (!key)
            return;
        if (!map.has(key))
            map.set(key, id);
        const flavored = `${this._flavor}\0${key}`;
        if (this._flavor && this._sourceMaps.has(map) && !map.has(flavored))
            map.set(flavored, id);
    }

    // A source's entry for a key, preferring one of the window's own flavor
    // (a native game gets the native launcher's shortcut); ownOnly: only
    // one of that flavor.
    find(map, key, ctx, ownOnly = false) {
        if (!key)
            return null;
        return map.get(`${flavorOf(ctx)}\0${key}`) ?? (ownOnly ? null : map.get(key)) ?? null;
    }

    // Looks a raw string (wm class, binary...) up in every map, strongest first.
    lookup(raw) {
        if (!raw)
            return null;
        const lower = stripExt(raw.toLowerCase());
        return this.wmClass.get(lower) ??
            this.id.get(lower) ??
            this.exec.get(lower) ??
            this.icon.get(lower) ??
            this.name.get(normalize(lower)) ??
            null;
    }

    exactPath(paths) {
        for (const path of paths) {
            const id = this.path.get(pathKey(path));
            if (id)
                return id;
        }
        return null;
    }

    // The entry whose install folder is closest above one of these paths.
    nearestDir(paths) {
        for (const path of paths) {
            for (const dir of selfAndParents(pathKey(path))) {
                const id = this.dir.get(dir);
                if (id)
                    return id;
            }
        }
        return null;
    }
}
