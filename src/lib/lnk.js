// Windows shortcuts (.lnk, the Shell Link format): the program one starts
// and the icon it shows. Wine's menu entries run them (`wine start /unix
// <...>.lnk`), installers put them in a prefix's Start Menu, and a launcher
// may be given one instead of a program. Its name says little about the
// program: Hearthstone.lnk starts "Hearthstone Beta Launcher.exe".

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {wineToHost} from './process.js';
import {StampCache, canonical} from './util.js';

// No real shortcut comes near this; a bigger file isn't one.
const MAX_SIZE = 64 * 1024;

const HEADER_SIZE = 0x4c;
// {00021401-0000-0000-C000-000000000046}
const CLSID = [0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46];

const HAS_ID_LIST = 0x1;
const HAS_LINK_INFO = 0x2;
const HAS_NAME = 0x4;
const HAS_RELATIVE_PATH = 0x8;
const HAS_WORKING_DIR = 0x10;
const HAS_ARGUMENTS = 0x20;
const HAS_ICON_LOCATION = 0x40;
const IS_UNICODE = 0x80;
// The strings that may follow, in their order (only some are of use here)
const STRINGS = [
    {flag: HAS_NAME, key: null},
    {flag: HAS_RELATIVE_PATH, key: 'relativePath'},
    {flag: HAS_WORKING_DIR, key: 'workingDir'},
    {flag: HAS_ARGUMENTS, key: 'arguments'},
    {flag: HAS_ICON_LOCATION, key: 'iconLocation'},
];
// LinkInfo flags: the target is on a local volume
const VOLUME_ID_AND_LOCAL_BASE_PATH = 0x1;

const utf16 = new TextDecoder('utf-16le');
// What Windows (and Wine) write for non-Unicode strings in the West.
const ansi = new TextDecoder('windows-1252');

// A NUL-terminated string at offset: one byte per character, or two.
function cString(view, offset, wide) {
    const step = wide ? 2 : 1;
    let end = offset;
    while (end + step <= view.byteLength && (wide ? view.getUint16(end, true) : view.getUint8(end)))
        end += step;
    if (end + step > view.byteLength)
        throw new Error('unterminated string');
    return (wide ? utf16 : ansi).decode(new Uint8Array(view.buffer, view.byteOffset + offset, end - offset));
}

// {target, relativePath, workingDir, arguments, iconLocation, iconIndex}:
// Windows paths as the shortcut gives them (null where it gives none), or
// null if the bytes aren't a shortcut.
export function parseLnk(bytes) {
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, true) !== HEADER_SIZE || CLSID.some((b, i) => view.getUint8(4 + i) !== b))
            return null;
        const flags = view.getUint32(0x14, true);
        const out = {target: null, relativePath: null, workingDir: null, arguments: null,
            iconLocation: null, iconIndex: view.getInt32(0x38, true)};
        let offset = HEADER_SIZE;
        if (flags & HAS_ID_LIST)
            offset += 2 + view.getUint16(offset, true);
        if (flags & HAS_LINK_INFO) {
            const size = view.getUint32(offset, true);
            const info = new DataView(view.buffer, view.byteOffset + offset, size);
            const headerSize = info.getUint32(4, true);
            if (info.getUint32(8, true) & VOLUME_ID_AND_LOCAL_BASE_PATH) {
                // Newer shortcuts also have both in UTF-16.
                const wide = headerSize >= 0x24;
                const base = cString(info, info.getUint32(wide ? 28 : 16, true), wide);
                const suffix = cString(info, info.getUint32(wide ? 32 : 24, true), wide);
                out.target = base + (suffix && !base.endsWith('\\') ? `\\${suffix}` : suffix);
            }
            offset += size;
        }
        // StringData: a count of characters, then the characters, for each
        // string the flags say is there, in this order.
        const wide = !!(flags & IS_UNICODE);
        for (const string of STRINGS) {
            if (!(flags & string.flag))
                continue;
            const length = view.getUint16(offset, true) * (wide ? 2 : 1);
            if (offset + 2 + length > view.byteLength)
                throw new Error('truncated string');
            // Some writers count the terminating NUL in (Blizzard's).
            if (string.key) {
                out[string.key] = (wide ? utf16 : ansi)
                    .decode(new Uint8Array(view.buffer, view.byteOffset + offset + 2, length)).replace(/\0+$/, '');
            }
            offset += 2 + length;
        }
        return out;
    } catch {
        return null;
    }
}

// The Wine prefix a host path lies in (the folder holding its drive_c),
// or null.
export function prefixOf(path) {
    const m = path.match(/^(.*?)\/drive_c(?:\/|$)/i);
    return m ? m[1] : null;
}

// path -> parseLnk() of it, until the file changes
const cache = new StampCache(path => {
    const stream = Gio.File.new_for_path(path).read(null);
    const bytes = stream.read_bytes(MAX_SIZE + 1, null).toArray();
    stream.close(null);
    return bytes.length <= MAX_SIZE ? parseLnk(bytes) : null;
});

// What a shortcut file points at, as host paths: {program, icon} (icon: a
// program or .ico whose icon it shows, or null), or null if it isn't a
// shortcut. prefix: the Wine prefix its C: is in; by default the one the
// file lies in.
export function readLnk(path, prefix = prefixOf(path)) {
    const lnk = cache.get(path);
    if (!lnk)
        return null;
    const host = winPath => {
        // Environment variables (%SystemRoot%...) aren't known here.
        if (!winPath || winPath.includes('%'))
            return null;
        return wineToHost(winPath, prefix);
    };
    // Without a full path, one relative to the shortcut.
    const relative = lnk.relativePath &&
        canonical(`${GLib.path_get_dirname(path)}/${lnk.relativePath.replace(/\\/g, '/')}`);
    const program = host(lnk.target) ?? relative;
    return program ? {program, icon: host(lnk.iconLocation)} : null;
}
