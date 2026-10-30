// The icon and product name stored in a Windows program (.exe), for Wine
// games no launcher made an icon for. Reads only the PE headers and the
// resources it needs, and saves the largest icon as a PNG under
// ~/.cache/icon-fix (the program itself is never written to).

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as log from './log.js';
import {fileStamp, readJson} from './util.js';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

// Random access to a file without reading all of it.
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

// Limits against broken or hostile files: nothing here may make the Shell
// read, allocate or loop without bound.
const MAX_ENTRIES = 4096;
// type -> name -> language
const MAX_DEPTH = 3;
const MAX_GROUP_BYTES = 64 << 10;
const MAX_ICON_BYTES = 4 << 20;
const MAX_VERSION_BYTES = 256 << 10;
const MAX_ICON_SIDE = 1024;

// A program's resource section, read piece by piece: installers keep their
// whole payload in it (hundreds of megabytes), and only a few hundred bytes
// of tables plus one icon image are needed. Offsets are relative to the
// section's start; data entries point at RVAs.
class Resources {
    constructor(reader, start, size, rva) {
        this._reader = reader;
        this._start = start;
        this._size = size;
        this._rva = rva;
    }

    _bytes(offset, length) {
        if (offset < 0 || offset + length > this._size)
            throw new RangeError('outside the resource section');
        return this._reader.bytes(this._start + offset, length);
    }

    // Entries of one resource directory: [{id, offset, isDir}] (named
    // entries get id null).
    _entries(offset) {
        const head = this._bytes(offset, 16);
        const count = head.getUint16(12, true) + head.getUint16(14, true);
        if (count > MAX_ENTRIES)
            throw new RangeError('too many resource entries');
        const table = count ? this._bytes(offset + 16, count * 8) : null;
        const list = [];
        for (let i = 0; i < count; i++) {
            const name = table.getUint32(i * 8, true);
            const target = table.getUint32(i * 8 + 4, true);
            list.push({
                id: name & 0x80000000 ? null : name,
                offset: target & 0x7fffffff,
                isDir: !!(target & 0x80000000),
            });
        }
        return list;
    }

    // Every resource of a type, first language only, not read yet:
    // [{id, offset, size}].
    list(type) {
        const typeEntry = this._entries(0).find(e => e.id === type && e.isDir);
        if (!typeEntry)
            return [];
        const found = [];
        for (const item of this._entries(typeEntry.offset)) {
            let leaf = item;
            // A directory pointing back at itself must not hang the Shell.
            for (let depth = 2; leaf?.isDir; depth++)
                leaf = depth < MAX_DEPTH ? this._entries(leaf.offset)[0] : null;
            if (!leaf)
                continue;
            const data = this._bytes(leaf.offset, 8);
            found.push({
                id: item.id,
                offset: data.getUint32(0, true) - this._rva,
                size: data.getUint32(4, true),
            });
        }
        return found;
    }

    // A resource's data, or null if it's missing or larger than max.
    read(item, max) {
        if (!item || item.size > max)
            return null;
        const view = this._bytes(item.offset, item.size);
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
}

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
        if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize))
            return new Resources(reader, rawPointer + (rva - virtualAddress), rawSize - (rva - virtualAddress), rva);
    }
    return null;
}

// Decodes an icon image: PNG as is, or a BMP DIB (32, 24, 8, 4 or 1 bits
// per pixel; the height counts the AND mask too). Returns a GdkPixbuf.
function decodeIcon(data) {
    if (PNG_MAGIC.every((b, i) => data[i] === b)) {
        const loader = new GdkPixbuf.PixbufLoader();
        // A tiny PNG may claim to be enormous; don't decode it at that size.
        loader.connect('size-prepared', (_loader, w, h) => {
            if (w > MAX_ICON_SIDE || h > MAX_ICON_SIDE)
                loader.set_size(Math.min(w, 256), Math.min(h, 256));
        });
        loader.write_bytes(new GLib.Bytes(data));
        loader.close();
        return loader.get_pixbuf();
    }

    const dib = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const headerSize = dib.getUint32(0, true);
    const width = dib.getInt32(4, true);
    const height = dib.getInt32(8, true) / 2;
    const bpp = dib.getUint16(14, true);
    if (width <= 0 || height <= 0 || width > MAX_ICON_SIDE || height > MAX_ICON_SIDE ||
        ![32, 24, 8, 4, 1].includes(bpp))
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
            // BGR(A) in the file, from the palette below 16 bits.
            let p, a = 255;
            if (bpp <= 8) {
                const bit = x * bpp;
                p = palette + (data[row + (bit >> 3)] >> (8 - bpp - (bit & 7)) & (1 << bpp) - 1) * 4;
            } else {
                p = row + x * (bpp / 8);
                if (bpp === 32) {
                    a = data[p + 3];
                    anyAlpha ||= a !== 0;
                }
            }
            const out = (y * width + x) * 4;
            rgba[out] = data[p + 2];
            rgba[out + 1] = data[p + 1];
            rgba[out + 2] = data[p];
            rgba[out + 3] = a;
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

// The program's own icon (its first icon group), largest image first. Only
// the images tried are read.
function bestIcon(resources) {
    const group = resources.read(resources.list(RT_GROUP_ICON)[0], MAX_GROUP_BYTES);
    if (!group)
        return null;
    const icons = new Map(resources.list(RT_ICON).map(r => [r.id, r]));
    const dir = new DataView(group.buffer, group.byteOffset, group.byteLength);
    const count = dir.getUint16(4, true);
    const candidates = [];
    for (let i = 0; i < count && 6 + i * 14 + 14 <= dir.byteLength; i++) {
        const e = 6 + i * 14;
        candidates.push({
            size: dir.getUint8(e) || 256,
            bpp: dir.getUint16(e + 6, true),
            image: icons.get(dir.getUint16(e + 12, true)),
        });
    }
    candidates.sort((a, b) => b.size - a.size || b.bpp - a.bpp);
    for (const c of candidates) {
        try {
            const data = resources.read(c.image, MAX_ICON_BYTES);
            const pixbuf = data && decodeIcon(data);
            if (pixbuf)
                return pixbuf;
        } catch {}
    }
    return null;
}

// The first of these strings the version info has (ProductName...). The
// String blocks hold a UTF-16 key, padding to 32 bits, then the value.
function versionString(resources, keys) {
    const version = resources.read(resources.list(RT_VERSION)[0], MAX_VERSION_BYTES);
    if (!version)
        return null;
    for (const key of keys) {
        const value = findString(version, key);
        if (value)
            return value;
    }
    return null;
}

function findString(version, key) {
    const needle = [...`${key}\0`].flatMap(c => [c.charCodeAt(0), 0]);
    // A String block starts with 3 words (lengths, type) before its key.
    for (let i = 6; i + needle.length <= version.length; i += 2) {
        if (version[i] !== needle[0] || !needle.every((b, j) => version[i + j] === b))
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

// Forgets what was read this session (what is saved on disk stays).
export function forgetRead() {
    known.clear();
}

// {icon: path to a PNG or null, name: product name or null} for a .exe,
// or null if it isn't a readable Windows program. The PNG goes to the
// cache unless dir says where (for icons a .desktop file will point at).
export function exeInfo(path, dir = cacheDir()) {
    const stamp = fileStamp(path);
    if (stamp === null)
        return null;
    const cached = known.get(`${dir}\n${path}`);
    // Its PNG may have been cleaned up since (see mirror/steam-flatpak.js).
    if (cached?.stamp === stamp && (!cached.info?.icon || GLib.file_test(cached.info.icon, GLib.FileTest.EXISTS)))
        return cached.info;

    // The PNG and what an earlier session found are named after the
    // program and its stamp: a changed program is read again.
    const sum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, `${path}\n${stamp}`, -1);
    const png = GLib.build_filenamev([dir, `${sum}.png`]);
    const found = GLib.build_filenamev([dir, `${sum}.json`]);
    // Saved by an earlier session (in the cache only: a mirror's folder
    // holds only its icons): no need to open the program again.
    const saved = dir === cacheDir() ? readJson(found) : null;
    if (saved && (!saved.icon || GLib.file_test(png, GLib.FileTest.EXISTS))) {
        const before = saved.program ? {icon: saved.icon ? png : null, name: saved.name} : null;
        known.set(`${dir}\n${path}`, {stamp, info: before});
        return before;
    }

    let info = null;
    let reader = null;
    const start = Date.now();
    try {
        reader = new Reader(path);
        const section = resourceSection(reader);
        if (section) {
            const name = versionString(section, ['ProductName', 'FileDescription']);
            let icon = png;
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
        log.debug(`${path}: ${info?.icon ? 'icon' : 'no icon'}, name ${JSON.stringify(info?.name ?? null)} (${Date.now() - start} ms)`);
    } catch (e) {
        log.debug(`can't read ${path} as a Windows program: ${e}`);
    }
    reader?.close();
    known.set(`${dir}\n${path}`, {stamp, info});
    if (dir === cacheDir()) {
        try {
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(found, JSON.stringify({program: !!info, icon: !!info?.icon, name: info?.name ?? null}));
        } catch (e) {
            log.debug(`can't save what ${path} holds: ${e}`);
        }
    }
    return info;
}

// Just the icon of a program (a PNG path), or null.
export function exeIcon(path, dir) {
    return path ? exeInfo(path, dir)?.icon ?? null : null;
}
