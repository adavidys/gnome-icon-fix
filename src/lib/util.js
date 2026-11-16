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

// Inside a Flatpak app's sandbox: ~/.var/app/<id>/...
export function sandboxDir(id, ...parts) {
    return home('.var', 'app', id, ...parts);
}

// Icon Fix's own cache: ~/.cache/icon-fix/...
export function cacheDir(...parts) {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'icon-fix', ...parts]);
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

// Cheap change detector for a file or directory: mtime (µs) and size; null
// if they can't be read. (In a folder we may list but not enter, Gio
// answers without them rather than failing.)
// What a file is, whatever path (and links) leads to it: its device and
// inode, or null if it can't be read.
export function fileId(path) {
    try {
        return Gio.File.new_for_path(path).query_info('id::file', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_string('id::file');
    } catch {
        return null;
    }
}

export function fileStamp(path) {
    let info;
    try {
        info = Gio.File.new_for_path(path).query_info(
            'time::modified,time::modified-usec,standard::size', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return null;
    }
    if (!info.has_attribute('time::modified') || !info.has_attribute('standard::size'))
        return null;
    return `${info.get_attribute_uint64('time::modified')}.` +
        `${info.get_attribute_uint32('time::modified-usec')}:${info.get_attribute_uint64('standard::size')}`;
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

    // Reads it again next time.
    forget(path) {
        this._entries.delete(path);
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
// Folders that usually hold many unrelated programs. Launchers add their
// libraries' (launchers.js, sharedDirs).
export const SHARED_DIR_NAMES = new Set([
    'bin', 'sbin', 'applications', 'appimages', 'apps', 'desktop', 'downloads',
    'games', 'scripts', 'programs', 'launchers', 'tools', 'drive_c',
    'program files', 'program files (x86)', 'windows', 'system32', 'syswow64',
    'common',
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
const ICON_SIZES = ['scalable', '1024x1024', '512x512', '256x256', '128x128', '96x96', '64x64', '48x48', '32x32', '24x24', '16x16'];

// A hicolor icon outside the icon theme's search path (inside a Flatpak's
// private data dir, or a bundle) as an absolute path, or null.
export function findHicolorIcon(share, name) {
    if (!name)
        return null;
    for (const size of ICON_SIZES) {
        for (const ext of size === 'scalable' ? ['svg'] : ['png', 'svg']) {
            const path = GLib.build_filenamev([share, 'icons', 'hicolor', size, 'apps', `${name}.${ext}`]);
            if (exists(path))
                return path;
        }
    }
    return null;
}

// An icon given by name that lies in a pixmaps folder (/usr/share/pixmaps,
// and the same under every data dir) rather than in an icon theme, as the
// desktop menu specification allows and older programs and packages do
// (osu-lazer-bin's Icon=osu-lazer): its path, or null.
export function findPixmap(name) {
    if (!name || name.includes('/'))
        return null;
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    for (const dir of dirs) {
        for (const ext of ['png', 'svg', 'xpm']) {
            const path = GLib.build_filenamev([dir, 'pixmaps', `${name}.${ext}`]);
            if (exists(path))
                return path;
        }
    }
    return null;
}

// The data folders of the Flatpak apps the user has run (~/.var/app/<id>),
// where an app keeps what it makes for others: the icons of the shortcuts
// a launcher creates (Flatpak Lutris: lutris_<slug>, Flatpak Steam:
// steam_icon_<id>) stay in it, out of the icon theme's reach.
const sandboxes = new StampCache(dir => listDir(dir).sort());

// An icon a shortcut names but only some Flatpak app's own data has, as
// an absolute path, or null. first: the app ids to look in before the
// others (the app the shortcut runs), in any case.
export function findSandboxedIcon(name, first = []) {
    if (!name || name.includes('/'))
        return null;
    const all = sandboxes.get(home('.var', 'app')) ?? [];
    const wanted = first.map(id => id.toLowerCase());
    const ids = new Set([...all.filter(id => wanted.includes(id.toLowerCase())), ...all]);
    for (const id of ids) {
        for (const share of [sandboxDir(id, 'data'), sandboxDir(id, '.local', 'share')]) {
            // Most apps keep no icons: one check, not dozens.
            if (!exists(`${share}/icons/hicolor`))
                continue;
            const path = findHicolorIcon(share, name);
            if (path)
                return path;
        }
    }
    return null;
}

// An image file copied under a name made from its content
// (~/.cache/icon-fix/<folder>/<sha1>.<ext>): the Shell keeps the pictures
// of icon files by their path and never looks at a file again, so an icon
// changed in place (a new picture saved over a game's icon) shows only
// under a new name. Also keeps an icon whose file goes away (an AppImage's
// mount). Its path, or null if it can't be read or written.
const copies = new Map();

export function copyByContent(path, folder) {
    if (!copies.has(folder))
        copies.set(folder, new StampCache(file => writeCopy(file, folder)));
    const cache = copies.get(folder);
    // A copy removed since (the cache cleaned): made again.
    const out = cache.get(path);
    if (out && !exists(out))
        cache.forget(path);
    return out && exists(out) ? out : cache.get(path);
}

function writeCopy(path, folder) {
    const bytes = GLib.file_get_contents(path)[1];
    // A file without an extension (an AppImage's .DirIcon): an SVG is told
    // by its first bytes.
    const ext = path.match(/\.(png|jpe?g|svgz?|xpm|ico|webp)$/i)?.[1].toLowerCase() ??
        (/^\s*(<\?xml|<svg)/.test(decoder.decode(bytes.slice(0, 64))) ? 'svg' : 'png');
    const dir = cacheDir(folder);
    const out = `${dir}/${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes)}.${ext}`;
    if (!exists(out)) {
        GLib.mkdir_with_parents(dir, 0o755);
        GLib.file_set_contents(out, bytes);
    }
    return out;
}
