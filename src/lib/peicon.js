// The icon and product name stored in a Windows program (.exe), for Wine
// games no launcher made an icon for. Reads only the PE headers and the
// resources it needs, and saves the largest icon as a PNG under
// ~/.cache/icon-fix (the program itself is never written to).

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {fileStamp} from './util.js';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

// Random access to a file without reading all of it (games ship
// executables of hundreds of megabytes).
class Reader {
    constructor(path) {
        this._stream = Gio.File.new_for_path(path).read(null);
    }

    bytes(offset, length) {
        this._stream.seek(offset, GLib.SeekType.SET, null);
        const data = this._stream.read_bytes(length, null).toArray();
        if (data.length !== length)
            throw new Error('short read');
        return new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    close() {
        this._stream.close(null);
    }
}

// The resource section as {view, rva}: the whole section is small next to
// the program, and its offsets are relative to its start.
function resourceSection(reader) {
    const dos = reader.bytes(0, 64);
    if (dos.getUint16(0, true) !== 0x5a4d) // MZ
        return null;
    const pe = dos.getUint32(0x3c, true);
    const coff = reader.bytes(pe, 24);
    if (coff.getUint32(0, true) !== 0x4550) // PE\0\0
        return null;
    const sections = coff.getUint16(6, true);
    const optSize = coff.getUint16(20, true);
    const opt = reader.bytes(pe + 24, optSize);
    const magic = opt.getUint16(0, true);
    const dirs = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
    if (dirs < 0 || optSize < dirs + 3 * 8)
        return null;
    const rva = opt.getUint32(dirs + 2 * 8, true);
    if (!rva)
        return null;

    const table = reader.bytes(pe + 24 + optSize, sections * 40);
    for (let i = 0; i < sections; i++) {
        const virtualSize = table.getUint32(i * 40 + 8, true);
        const virtualAddress = table.getUint32(i * 40 + 12, true);
        const rawSize = table.getUint32(i * 40 + 16, true);
        const rawPointer = table.getUint32(i * 40 + 20, true);
        if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
            const start = rawPointer + (rva - virtualAddress);
            const size = Math.min(rawSize - (rva - virtualAddress), 64 << 20);
            return {view: reader.bytes(start, size), rva};
        }
    }
    return null;
}

// Entries of one resource directory: [{id, offset, isDir}] (named entries
// get id null).
function entries(view, offset) {
    const named = view.getUint16(offset + 12, true);
    const ids = view.getUint16(offset + 14, true);
    const list = [];
    for (let i = 0; i < named + ids; i++) {
        const name = view.getUint32(offset + 16 + i * 8, true);
        const target = view.getUint32(offset + 16 + i * 8 + 4, true);
        list.push({
            id: name & 0x80000000 ? null : name,
            offset: target & 0x7fffffff,
            isDir: !!(target & 0x80000000),
        });
    }
    return list;
}

// Every resource of a type: [{id, data: Uint8Array}], first language only.
function resources({view, rva}, type) {
    const typeEntry = entries(view, 0).find(e => e.id === type && e.isDir);
    if (!typeEntry)
        return [];
    const found = [];
    for (const item of entries(view, typeEntry.offset)) {
        let leaf = item;
        while (leaf?.isDir)
            leaf = entries(view, leaf.offset)[0];
        if (!leaf)
            continue;
        const dataRva = view.getUint32(leaf.offset, true);
        const size = view.getUint32(leaf.offset + 4, true);
        const start = dataRva - rva;
        if (start < 0 || start + size > view.byteLength)
            continue;
        found.push({
            id: item.id,
            data: new Uint8Array(view.buffer, view.byteOffset + start, size),
        });
    }
    return found;
}

// Decodes an icon image: PNG as is, or a BMP DIB (32, 24, 8, 4 or 1 bits
// per pixel; the height counts the AND mask too). Returns a GdkPixbuf.
function decodeIcon(data) {
    if (PNG_MAGIC.every((b, i) => data[i] === b)) {
        const loader = new GdkPixbuf.PixbufLoader();
        loader.write_bytes(new GLib.Bytes(data));
        loader.close();
        return loader.get_pixbuf();
    }

    const dib = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerSize = dib.getUint32(0, true);
    const width = dib.getInt32(4, true);
    const height = dib.getInt32(8, true) / 2;
    const bpp = dib.getUint16(14, true);
    if (width <= 0 || height <= 0 || ![32, 24, 8, 4, 1].includes(bpp))
        return null;
    const colors = bpp <= 8 ? dib.getUint32(32, true) || 1 << bpp : 0;
    const palette = headerSize;
    const pixels = palette + colors * 4;
    const stride = Math.ceil(width * bpp / 32) * 4;
    const maskStride = Math.ceil(width / 32) * 4;
    const mask = pixels + stride * height;

    const rgba = new Uint8Array(width * height * 4);
    let anyAlpha = false;
    for (let y = 0; y < height; y++) {
        // Bottom-up rows.
        const row = pixels + (height - 1 - y) * stride;
        for (let x = 0; x < width; x++) {
            let b, g, r, a = 255;
            if (bpp <= 8) {
                const bit = x * bpp;
                const index = data[row + (bit >> 3)] >> (8 - bpp - (bit & 7)) & (1 << bpp) - 1;
                const p = palette + index * 4;
                [b, g, r] = [data[p], data[p + 1], data[p + 2]];
            } else {
                const p = row + x * (bpp / 8);
                [b, g, r] = [data[p], data[p + 1], data[p + 2]];
                if (bpp === 32) {
                    a = data[p + 3];
                    anyAlpha ||= a !== 0;
                }
            }
            rgba.set([r, g, b, a], (y * width + x) * 4);
        }
    }
    // Without an alpha channel, transparency comes from the AND mask.
    if (!anyAlpha && mask + maskStride * height <= data.length) {
        for (let y = 0; y < height; y++) {
            const row = mask + (height - 1 - y) * maskStride;
            for (let x = 0; x < width; x++) {
                const transparent = data[row + (x >> 3)] & (0x80 >> (x & 7));
                rgba[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
            }
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(rgba),
        GdkPixbuf.Colorspace.RGB, true, 8, width, height, width * 4);
}

// The program's own icon (its first icon group), largest image first.
function bestIcon(section) {
    const group = resources(section, RT_GROUP_ICON)[0];
    if (!group)
        return null;
    const icons = new Map(resources(section, RT_ICON).map(r => [r.id, r.data]));
    const dir = new DataView(group.data.buffer, group.data.byteOffset, group.data.byteLength);
    const count = dir.getUint16(4, true);
    const candidates = [];
    for (let i = 0; i < count && 6 + i * 14 + 14 <= dir.byteLength; i++) {
        const e = 6 + i * 14;
        candidates.push({
            size: dir.getUint8(e) || 256,
            bpp: dir.getUint16(e + 6, true),
            data: icons.get(dir.getUint16(e + 12, true)),
        });
    }
    candidates.sort((a, b) => b.size - a.size || b.bpp - a.bpp);
    for (const c of candidates) {
        if (!c.data)
            continue;
        try {
            const pixbuf = decodeIcon(c.data);
            if (pixbuf)
                return pixbuf;
        } catch {}
    }
    return null;
}

// A string from the version info, e.g. ProductName. The String blocks hold
// a UTF-16 key, padding to 32 bits, then the UTF-16 value.
function versionString(section, key) {
    const version = resources(section, RT_VERSION)[0]?.data;
    if (!version)
        return null;
    const needle = [...`${key}\0`].flatMap(c => [c.charCodeAt(0), 0]);
    for (let i = 0; i + needle.length <= version.length; i += 2) {
        if (!needle.every((b, j) => version[i + j] === b))
            continue;
        const valueLength = version[i - 4] | version[i - 3] << 8;
        const start = (i + needle.length + 3) & ~3;
        const value = new TextDecoder('utf-16le').decode(
            version.subarray(start, start + valueLength * 2)).replace(/\0+$/, '').trim();
        return value || null;
    }
    return null;
}

function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'icon-fix', 'exe-icons']);
}

// "dir\npath" -> {stamp, info}
const known = new Map();

// {icon: path to a PNG or null, name: product name or null} for a .exe,
// or null if it isn't a readable Windows program. The PNG goes to the
// cache unless dir says where (for icons a .desktop file will point at).
export function exeInfo(path, dir = cacheDir()) {
    const stamp = fileStamp(path);
    if (stamp === null)
        return null;
    const cached = known.get(`${dir}\n${path}`);
    if (cached?.stamp === stamp)
        return cached.info;

    let info = null;
    let reader = null;
    try {
        reader = new Reader(path);
        const section = resourceSection(reader);
        if (section) {
            const name = versionString(section, 'ProductName') ??
                versionString(section, 'FileDescription');
            const sum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, `${path}\n${stamp}`, -1);
            let icon = GLib.build_filenamev([dir, `${sum}.png`]);
            if (!GLib.file_test(icon, GLib.FileTest.EXISTS)) {
                const pixbuf = bestIcon(section);
                if (pixbuf) {
                    GLib.mkdir_with_parents(dir, 0o755);
                    pixbuf.savev(icon, 'png', [], []);
                } else {
                    icon = null;
                }
            }
            info = {icon, name};
        }
    } catch (e) {
        console.debug(`Icon Fix: can't read ${path}: ${e}`);
    } finally {
        try {
            reader?.close();
        } catch {}
    }
    known.set(`${dir}\n${path}`, {stamp, info});
    return info;
}
