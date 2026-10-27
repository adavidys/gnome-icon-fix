// Steam from Flathub writes its game shortcuts inside its own sandbox home,
// where GNOME never looks, and their Exec calls a `steam` binary the host
// doesn't have. When enabled, we mirror each shortcut into the user's
// applications dir as steam-flatpak-<id>.desktop with a working Exec and an
// absolute Icon path. Only files we generated (prefix + marker key) are ever
// written or removed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {exists, findHicolorIcon, listDir, readText} from '../lib/util.js';

const STEAM_APP = 'com.valvesoftware.Steam';
const PREFIX = 'steam-flatpak-';
const MARKER = 'X-IconFix-Generated';
const GROUP = 'Desktop Entry';
const SYNC_DELAY_MS = 1000;
// How often to look for the shortcuts dir while Steam isn't installed yet.
const WAIT_SECONDS = 30;
const encoder = new TextEncoder();

function steamShare() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.var', 'app', STEAM_APP, '.local', 'share']);
}

// Icon= in a Flatpak Steam shortcut names an icon in the sandbox's own
// hicolor theme; turn it into a path the host can read.
function resolveIcon(share, icon) {
    if (icon?.startsWith('/'))
        return exists(icon) ? icon : null;
    return findHicolorIcon(share, icon);
}

// Returns the host .desktop contents for one Flatpak shortcut, or null if it
// isn't a Steam game shortcut.
export function convertShortcut(share, data) {
    const kf = new GLib.KeyFile();
    try {
        kf.load_from_bytes(new GLib.Bytes(encoder.encode(data)),
            GLib.KeyFileFlags.KEEP_COMMENTS | GLib.KeyFileFlags.KEEP_TRANSLATIONS);
    } catch {
        return null;
    }

    let exec;
    try {
        exec = kf.get_string(GROUP, 'Exec');
    } catch {
        return null;
    }
    const gameId = exec.match(/steam:\/\/rungameid\/(\d+)/)?.[1];
    if (!gameId)
        return null;

    kf.set_string(GROUP, 'Exec', `flatpak run ${STEAM_APP} steam://rungameid/${gameId}`);
    // TryExec=steam would hide the entry on a host without that binary.
    try {
        kf.remove_key(GROUP, 'TryExec');
    } catch {}
    // Real Steam games run as steam_app_<id>; non-Steam shortcuts (64-bit
    // ids) don't, the extension's matcher handles those.
    if (BigInt(gameId) <= 0xffffffffn)
        kf.set_string(GROUP, 'StartupWMClass', `steam_app_${gameId}`);

    let icon = null;
    try {
        icon = kf.get_string(GROUP, 'Icon');
    } catch {}
    const iconPath = resolveIcon(share, icon);
    if (iconPath)
        kf.set_string(GROUP, 'Icon', iconPath);

    kf.set_boolean(GROUP, MARKER, true);
    return {gameId, data: kf.to_data()[0]};
}

export class FlatpakSteamMirror {
    constructor() {
        this._share = steamShare();
        this._source = GLib.build_filenamev([this._share, 'applications']);
        this._target = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
        this._syncId = 0;
        this._waitId = 0;
        this._monitor = null;

        this._watch();
        this.sync();
    }

    destroy() {
        this._unwatch();
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
    }

    // A monitor on a missing dir never fires, so until Steam has created it
    // just check for it now and then.
    _watch() {
        const dir = Gio.File.new_for_path(this._source);
        if (!dir.query_exists(null)) {
            this._waitId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, WAIT_SECONDS, () => {
                if (!dir.query_exists(null))
                    return GLib.SOURCE_CONTINUE;
                this._waitId = 0;
                this._watch();
                this._queueSync();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_monitor, file, _other, event) => {
            this._queueSync();
            // Steam was uninstalled: wait for it to come back.
            if (event === Gio.FileMonitorEvent.DELETED && file.equal(dir)) {
                this._unwatch();
                this._watch();
            }
        });
    }

    _unwatch() {
        this._monitor?.cancel();
        this._monitor = null;
        if (this._waitId) {
            GLib.source_remove(this._waitId);
            this._waitId = 0;
        }
    }

    // Steam rewrites shortcuts in bursts while installing; settle first.
    _queueSync() {
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DELAY_MS, () => {
            this._syncId = 0;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    sync() {
        const wanted = new Map();
        for (const name of listDir(this._source)) {
            if (!name.endsWith('.desktop'))
                continue;
            const data = readText(GLib.build_filenamev([this._source, name]));
            const out = data && convertShortcut(this._share, data);
            if (out)
                wanted.set(`${PREFIX}${out.gameId}.desktop`, out.data);
        }

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

        // Game uninstalled: drop its mirror.
        for (const name of listDir(this._target)) {
            if (!name.startsWith(PREFIX) || !name.endsWith('.desktop') || wanted.has(name))
                continue;
            removeIfGenerated(GLib.build_filenamev([this._target, name]));
        }
    }

    // Used when the setting is switched off.
    static removeAll() {
        const target = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
        for (const name of listDir(target)) {
            if (name.startsWith(PREFIX) && name.endsWith('.desktop'))
                removeIfGenerated(GLib.build_filenamev([target, name]));
        }
    }
}

function isGenerated(data) {
    return new RegExp(`^${MARKER}=true$`, 'm').test(data);
}

function removeIfGenerated(path) {
    const data = readText(path);
    if (data !== null && isGenerated(data))
        GLib.unlink(path);
}
