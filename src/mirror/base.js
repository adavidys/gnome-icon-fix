// What the shortcut mirrors share: watch some folders (waiting for those
// that don't exist yet), rebuild the shortcuts that should exist after a
// pause, write only files carrying our marker, and remove ours that aren't
// wanted anymore along with the icons nothing uses.
//
// Each mirror has its own file name prefix and its own icon folder, so
// their files never mix (the preferences list them per mirror).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {listDir, readText} from '../lib/util.js';

export const MARKER = 'X-IconFix-Generated';
export const GROUP = 'Desktop Entry';

const SYNC_DELAY_MS = 1000;
// How often to look for a missing folder (the launcher isn't installed yet).
const WAIT_SECONDS = 30;

export function applicationsDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
}

export class ShortcutMirror {
    // prefix: file name prefix of our shortcuts; iconDir: the folder for
    // icons we make. Subclasses set up their own fields, then call start().
    constructor(prefix, iconDir) {
        this._prefix = prefix;
        this._iconDir = iconDir;
        this._target = applicationsDir();
        this._syncId = 0;
        // folder -> wait timer id / file monitor
        this._waits = new Map();
        this._monitors = new Map();
    }

    // Folders whose changes mean the shortcuts may have to change.
    _watchedDirs() {
        return [];
    }

    // file name -> .desktop contents of every shortcut that should exist.
    _wanted() {
        return new Map();
    }

    start() {
        this.sync();
    }

    destroy() {
        for (const path of new Set([...this._monitors.keys(), ...this._waits.keys()]))
            this._unwatch(path);
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
    }

    sync() {
        const wanted = this._wanted();

        GLib.mkdir_with_parents(this._target, 0o755);
        for (const [name, data] of wanted) {
            const path = GLib.build_filenamev([this._target, name]);
            const current = readText(path);
            if (current === data)
                continue;
            // Never overwrite a same-named file we didn't create.
            if (current !== null && !isGenerated(current))
                continue;
            GLib.file_set_contents(path, data);
        }

        // Game uninstalled: drop its shortcut, and icons nothing uses anymore.
        for (const file of generatedFiles(this._prefix, this._iconDir)) {
            if (file.kind === 'shortcut' && !wanted.has(GLib.path_get_basename(file.path)))
                GLib.unlink(file.path);
        }
        const used = [...wanted.values()].join('\n');
        for (const name of listDir(this._iconDir)) {
            const path = GLib.build_filenamev([this._iconDir, name]);
            if (!used.includes(`Icon=${path}\n`))
                GLib.unlink(path);
        }

        this._updateWatches();
    }

    // The folders to watch may change with what sync found (a new bottle).
    _updateWatches() {
        const dirs = new Set(this._watchedDirs());
        for (const path of new Set([...this._monitors.keys(), ...this._waits.keys()])) {
            if (!dirs.has(path))
                this._unwatch(path);
        }
        for (const path of dirs) {
            if (!this._monitors.has(path) && !this._waits.has(path))
                this._watch(path);
        }
    }

    // A monitor on a missing folder never fires, so until it exists just
    // check for it now and then.
    _watch(path) {
        const dir = Gio.File.new_for_path(path);
        if (!dir.query_exists(null)) {
            this._waits.set(path, GLib.timeout_add_seconds(GLib.PRIORITY_LOW, WAIT_SECONDS, () => {
                if (!dir.query_exists(null))
                    return GLib.SOURCE_CONTINUE;
                this._waits.delete(path);
                this._watch(path);
                this._queueSync();
                return GLib.SOURCE_REMOVE;
            }));
            return;
        }

        const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        monitor.connect('changed', (_monitor, file, _other, event) => {
            this._queueSync();
            // The launcher was uninstalled: wait for it to come back.
            if (event === Gio.FileMonitorEvent.DELETED && file.equal(dir)) {
                this._unwatch(path);
                this._watch(path);
            }
        });
        this._monitors.set(path, monitor);
    }

    _unwatch(path) {
        this._monitors.get(path)?.cancel();
        this._monitors.delete(path);
        if (this._waits.has(path))
            GLib.source_remove(this._waits.get(path));
        this._waits.delete(path);
    }

    // Launchers rewrite their files in bursts; settle first.
    _queueSync() {
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DELAY_MS, () => {
            this._syncId = 0;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }
}

// Every file a mirror made: its shortcuts (prefix + our marker) and the
// icons in its folder. [{path, name, icon, kind: 'shortcut' | 'icon'}];
// icon is a path or an icon name.
export function generatedFiles(prefix, iconDir) {
    const files = [];
    const target = applicationsDir();
    for (const name of listDir(target)) {
        if (!name.startsWith(prefix) || !name.endsWith('.desktop'))
            continue;
        const path = GLib.build_filenamev([target, name]);
        const data = readText(path);
        if (data === null || !isGenerated(data))
            continue;
        files.push({
            path,
            name: data.match(/^Name=(.*)$/m)?.[1] ?? name,
            icon: data.match(/^Icon=(.+)$/m)?.[1] ?? null,
            kind: 'shortcut',
        });
    }
    for (const name of listDir(iconDir)) {
        const path = GLib.build_filenamev([iconDir, name]);
        files.push({path, name, icon: path, kind: 'icon'});
    }
    return files;
}

// When a mirror is switched off.
export function removeGenerated(prefix, iconDir) {
    for (const file of generatedFiles(prefix, iconDir))
        GLib.unlink(file.path);
}

export function isGenerated(data) {
    return new RegExp(`^${MARKER}=true$`, 'm').test(data);
}
