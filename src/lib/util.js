// Small helpers shared by the matcher and the sources. Kept free of
// Shell/St imports so everything under lib/ and sources/ runs in plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder();

export function normalize(str) {
    if (!str)
        return '';
    return str.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function basename(path) {
    return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
}

export function stripExt(name) {
    return name.replace(/\.(exe|lnk|bat|sh|py|appimage|x86_64|x86|bin|run|desktop)$/i, '');
}

// "C:\\Games\\Foo.exe", "/opt/foo/foo.x86_64", "foo.exe" -> "foo"
export function exeStem(path) {
    return stripExt(basename(path).toLowerCase());
}

// "/a//b/../c/" -> "/a/c"; null for anything that isn't an absolute path.
export function canonical(path) {
    if (typeof path !== 'string' || !path.startsWith('/'))
        return null;
    return Gio.File.new_for_path(path).get_path();
}

export function home(...parts) {
    return GLib.build_filenamev([GLib.get_home_dir(), ...parts]);
}

export function dataDir(...parts) {
    return GLib.build_filenamev([GLib.get_user_data_dir(), ...parts]);
}

export function configDir(...parts) {
    return GLib.build_filenamev([GLib.get_user_config_dir(), ...parts]);
}

export function exists(path) {
    return !!path && GLib.file_test(path, GLib.FileTest.EXISTS);
}

export function listDir(path) {
    const names = [];
    try {
        const iter = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)))
            names.push(info.get_name());
        iter.close(null);
    } catch {}
    return names;
}

export function readText(path) {
    try {
        return decoder.decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

export function readJson(path) {
    const text = readText(path);
    if (text === null)
        return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// Cheap change detector for a file or directory: mtime (µs) and size.
export function fileStamp(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'time::modified,time::modified-usec,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        return `${info.get_attribute_uint64('time::modified')}.` +
            `${info.get_attribute_uint32('time::modified-usec')}:${info.get_size()}`;
    } catch {
        return null;
    }
}

// Runs load(path) on demand and keeps the result until the file (or, for a
// directory, its list of entries) changes. Missing paths give null.
export class StampCache {
    constructor(load) {
        this._load = load;
        this._entries = new Map();
    }

    get(path) {
        const stamp = fileStamp(path);
        if (stamp === null) {
            this._entries.delete(path);
            return null;
        }
        const cached = this._entries.get(path);
        if (cached?.stamp === stamp)
            return cached.value;
        let value = null;
        try {
            value = this._load(path);
        } catch {}
        this._entries.set(path, {stamp, value});
        return value;
    }
}

// Lowercased, since paths taken from a Wine argv don't keep the real case.
export function pathKey(path) {
    return path.toLowerCase();
}

// "/a/b/c" -> "/a/b/c", "/a/b", "/a"
export function* selfAndParents(path) {
    for (let p = path; p && p !== '/'; p = p.slice(0, p.lastIndexOf('/')))
        yield p;
}

export function isUnder(path, dir) {
    return path === dir || path.startsWith(`${dir}/`);
}

const SYSTEM_DIR = /^\/(?:usr|bin|sbin|lib\w*|etc|var|tmp|run|proc|sys|dev|snap|nix|app|boot|srv)(?:\/|$)/;
// Folders that usually hold many unrelated programs.
const SHARED_DIR_NAMES = new Set([
    'bin', 'sbin', 'applications', 'appimages', 'apps', 'desktop', 'downloads',
    'games', 'scripts', 'programs', 'launchers', 'tools', 'drive_c',
    'program files', 'program files (x86)', 'windows', 'system32', 'syswow64',
    'common', 'steamapps',
]);

// Whether a folder is specific enough to say "a process running from here
// belongs to that app".
export function isSpecificDir(dir) {
    if (!dir || dir.split('/').filter(Boolean).length < 2)
        return false;
    const home = GLib.get_home_dir();
    if (isUnder(home, dir))
        return false;
    // Home is /var/home/<user> on Silverblue, Bazzite and friends.
    if (!isUnder(dir, home) && SYSTEM_DIR.test(dir))
        return false;
    return !SHARED_DIR_NAMES.has(basename(dir).toLowerCase());
}

// Largest first: GNOME scales the absolute-path icon down as needed.
const ICON_SIZES = ['256x256', '128x128', '96x96', '64x64', '48x48', '32x32', '24x24', '16x16'];

// A hicolor icon outside the icon theme's search path (inside a Flatpak's
// private data dir) as an absolute path, or null.
export function findHicolorIcon(share, name) {
    if (!name)
        return null;
    for (const size of ICON_SIZES) {
        for (const ext of ['png', 'svg']) {
            const path = GLib.build_filenamev([share, 'icons', 'hicolor', size, 'apps', `${name}.${ext}`]);
            if (exists(path))
                return path;
        }
    }
    return null;
}
