// Lookup tables over the installed .desktop entries. Built every time the
// installed apps change (in bursts while Steam installs a game), so building
// only parses the entries and never touches the disk; sources that need
// their launcher's files read them later, when a window has to be matched.

import GLib from 'gi://GLib';

import {programFromArgv} from './process.js';
import {canonical, exeStem, isSpecificDir, normalize, pathKey, selfAndParents, stripExt} from './util.js';

// Calls an optional source method; a broken source must not take the
// others down with it.
export function tryCall(source, method, ...args) {
    try {
        return source[method]?.(...args) ?? null;
    } catch (e) {
        console.error(`Icon Fix: ${source.name}.${method}: ${e}`);
        return null;
    }
}

export class AppIndex {
    // entries: [{id, name, wmClass, exec, icon, path}] (strings, may be null)
    // sources: see sources/registry.js
    constructor(entries, sources = []) {
        this.wmClass = new Map();
        this.id = new Map();
        this.exec = new Map();
        this.icon = new Map();
        this.name = new Map();
        // Host path of the program in Exec= -> id
        this.path = new Map();
        // Install folder (the program's folder, or Path=) -> id
        this.dir = new Map();
        // id -> name of the source whose launcher the entry runs
        this.owner = new Map();
        // Tables the sources keep for themselves, see map()
        this._maps = new Map();

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
            const id = e.id;
            const shortId = id.replace(/\.desktop$/, '').toLowerCase();
            this.add(this.id, shortId, id);
            this.add(this.id, shortId.split('.').pop(), id);
            this.add(this.wmClass, e.wmClass?.toLowerCase(), id);
            this.add(this.name, normalize(e.name), id);
            if (e.icon && !e.icon.startsWith('/'))
                this.add(this.icon, e.icon.toLowerCase(), id);

            let argv = [];
            if (e.exec) {
                try {
                    argv = GLib.shell_parse_argv(e.exec.replace(/%[a-zA-Z]/g, ''))[1];
                } catch {}
            }

            // Every source sees every entry (Steam also indexes Icon=), any
            // of them can claim it as its launcher.
            let claimed = false;
            for (const source of sources) {
                if (tryCall(source, 'indexEntry', e, argv, this) && !claimed) {
                    claimed = true;
                    this.owner.set(id, source.name);
                }
            }

            if (!claimed) {
                const program = programFromArgv(argv);
                if (program?.flatpak) {
                    this.add(this.exec, program.flatpak, id);
                } else if (program?.path) {
                    this.add(this.exec, exeStem(program.path), id);
                    const path = canonical(program.path);
                    if (path) {
                        this.add(this.path, pathKey(path), id);
                        noteDir(path.slice(0, path.lastIndexOf('/')), id);
                    }
                }
            }
            noteDir(canonical(e.path), id);
        }

        for (const [dir, ids] of dirs) {
            if (ids.size === 1 && isSpecificDir(dir))
                this.dir.set(pathKey(dir), [...ids][0]);
        }
    }

    // A table of the given name, for a source's own keys.
    map(name) {
        let map = this._maps.get(name);
        if (!map) {
            map = new Map();
            this._maps.set(name, map);
        }
        return map;
    }

    add(map, key, id) {
        if (key && !map.has(key))
            map.set(key, id);
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
