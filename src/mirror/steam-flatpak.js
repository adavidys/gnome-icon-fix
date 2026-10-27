// Steam from Flathub writes its game shortcuts inside its own sandbox home
// (its applications dir, and its Desktop for "Add desktop shortcut"), where
// GNOME never looks, and their Exec calls a `steam` binary the host
// doesn't have. When enabled, we mirror each shortcut into the user's
// applications dir as steam-flatpak-<id>.desktop with a working Exec and an
// absolute Icon path. Non-Steam games get their name and icon from Steam's
// shortcuts.vdf (or the .exe). Only files we generated (prefix + marker key)
// are ever written or removed.

import GLib from 'gi://GLib';

import {exists, findHicolorIcon, listDir, readText} from '../lib/util.js';
import {readShortcuts, shortcutFiles, shortcutLook} from '../sources/steam.js';
import {GROUP, MARKER, ShortcutMirror, generatedFiles as filesOf, removeGenerated} from './base.js';

const STEAM_APP = 'com.valvesoftware.Steam';
const PREFIX = 'steam-flatpak-';
const encoder = new TextEncoder();

function steamShare() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.var', 'app', STEAM_APP, '.local', 'share']);
}

// Icons taken from non-Steam games' .exe files, for our shortcuts to use.
export function iconDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'icon-fix', 'icons']);
}

// Icon= in a Flatpak Steam shortcut names an icon in the sandbox's own
// hicolor theme; turn it into a path the host can read.
function resolveIcon(share, icon) {
    if (icon?.startsWith('/'))
        return exists(icon) ? icon : null;
    return findHicolorIcon(share, icon);
}

// Returns the host .desktop contents for one Flatpak shortcut, or null if it
// isn't a Steam game shortcut. nonSteam(id) gives {name, icon} for a
// non-Steam game's 32-bit id.
export function convertShortcut(share, data, nonSteam = () => null) {
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
    let iconPath = resolveIcon(share, icon);
    // Steam leaves Icon= empty and names them "Game.exe".
    const extra = BigInt(gameId) > 0xffffffffn ? nonSteam(String(BigInt(gameId) >> 32n)) : null;
    iconPath ??= extra?.icon ?? null;
    if (iconPath)
        kf.set_string(GROUP, 'Icon', iconPath);
    if (extra?.name)
        kf.set_string(GROUP, 'Name', extra.name);

    kf.set_boolean(GROUP, MARKER, true);
    return {gameId, data: kf.to_data()[0]};
}

export class FlatpakSteamMirror extends ShortcutMirror {
    constructor() {
        super(PREFIX, iconDir());
        this._share = steamShare();
        this._sources = [
            GLib.build_filenamev([this._share, 'applications']),
            GLib.build_filenamev([GLib.get_home_dir(), '.var', 'app', STEAM_APP, 'Desktop']),
        ];
        this.start();
    }

    _watchedDirs() {
        return this._sources;
    }

    _wanted() {
        let shortcuts = null;
        const nonSteam = id => {
            shortcuts ??= shortcutFiles(GLib.build_filenamev([this._share, 'Steam'])).flatMap(readShortcuts);
            const shortcut = shortcuts.find(s => s.id === id);
            return shortcut ? shortcutLook(shortcut, iconDir()) : null;
        };
        const wanted = new Map();
        for (const dir of this._sources) {
            for (const name of listDir(dir)) {
                if (!name.endsWith('.desktop'))
                    continue;
                const data = readText(GLib.build_filenamev([dir, name]));
                const out = data && convertShortcut(this._share, data, nonSteam);
                if (out && !wanted.has(`${PREFIX}${out.gameId}.desktop`))
                    wanted.set(`${PREFIX}${out.gameId}.desktop`, out.data);
            }
        }
        return wanted;
    }

    static removeAll() {
        removeGenerated(PREFIX, iconDir());
    }
}

// The files this mirror made, for the preferences window.
export function generatedFiles() {
    return filesOf(PREFIX, iconDir());
}
