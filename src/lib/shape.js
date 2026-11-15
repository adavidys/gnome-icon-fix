// Rounded corners for square icons. Icons cut from a game's .exe, Steam's
// library pictures and many AppImage icons are plain squares, which look
// out of place next to GNOME's rounded ones. Such an icon is redrawn once
// with its corners rounded and kept in ~/.cache/icon-fix/rounded; icons
// that already have a shape of their own (transparent corners) are left
// as they are.
//
// The radius is a share of the icon's side: GNOME's square app icons
// (Console, Text Editor, Builder) round theirs by about a sixth.

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {cacheDir, exists, fileStamp} from './util.js';

export const DEFAULT_RADIUS = 16;

// Icons are worked on at least this big: rounding a 32px icon at 32px
// leaves jagged corners once GNOME scales it up for the dock.
const MIN_SIZE = 128;
const MAX_SIZE = 256;
// Alpha above which a pixel counts as part of the picture.
const SOLID = 200;
const VISIBLE = 16;

// path + stamp + radius -> rounded path or the same path
const known = new Map();

// The box (x0, y0, x1, y1, inclusive) of the visible pixels, or null.
function visibleBox(pixels, width, height, stride, channels) {
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        for (let x = 0; x < width; x++) {
            if (channels === 3 || pixels[row + x * 4 + 3] > VISIBLE) {
                if (x < x0)
                    x0 = x;
                if (x > x1)
                    x1 = x;
                if (y < y0)
                    y0 = y;
                y1 = y;
            }
        }
    }
    return x1 < 0 ? null : {x0, y0, x1, y1};
}

// Whether a pixel is solid.
function solid(pixels, stride, channels, x, y) {
    return channels === 3 || pixels[y * stride + x * channels + 3] > SOLID;
}

// Whether the picture is a square-cornered block: its visible box is
// (nearly) square and solid right into at least three of its corners.
export function isSquare(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const pixels = pixbuf.get_pixels();
    const box = visibleBox(pixels, width, height, stride, channels);
    if (!box)
        return null;
    const w = box.x1 - box.x0 + 1;
    const h = box.y1 - box.y0 + 1;
    if (Math.min(w, h) < 8 || Math.abs(w - h) > Math.max(w, h) * 0.1)
        return null;
    // One pixel in from each corner: antialiased edges are half covered.
    const inset = Math.max(1, Math.round(Math.min(w, h) / 64));
    const left = box.x0 + inset;
    const right = box.x1 - inset;
    const top = box.y0 + inset;
    const bottom = box.y1 - inset;
    const solidCorners = [solid(pixels, stride, channels, left, top), solid(pixels, stride, channels, right, top),
        solid(pixels, stride, channels, left, bottom), solid(pixels, stride, channels, right, bottom)];
    return solidCorners.filter(Boolean).length >= 3 ? box : null;
}

// The coverage of a pixel by a box with rounded corners of radius r,
// antialiased over one pixel.
function coverage(x, y, box, r) {
    const px = x + 0.5;
    const py = y + 0.5;
    const left = box.x0 + r;
    const right = box.x1 + 1 - r;
    const top = box.y0 + r;
    const bottom = box.y1 + 1 - r;
    const cx = px < left ? left : px > right ? right : null;
    const cy = py < top ? top : py > bottom ? bottom : null;
    if (cx === null || cy === null)
        return 1;
    const distance = Math.hypot(px - cx, py - cy);
    return Math.min(1, Math.max(0, r - distance + 0.5));
}

// A copy of pixbuf with the corners of its square picture (box) rounded
// by radius percent of its side. Only the corners change.
export function roundCorners(pixbuf, box, radius) {
    const src = pixbuf.get_has_alpha() ? pixbuf : pixbuf.add_alpha(false, 0, 0, 0);
    const stride = src.get_rowstride();
    const pixels = src.get_pixels();
    const r = Math.min(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1) * radius / 100;
    const reach = Math.ceil(r);
    // The four corner squares, each reach pixels wide: where they start.
    const xs = [box.x0, box.x1 + 1 - reach];
    const ys = [box.y0, box.y1 + 1 - reach];
    for (const ya of ys) {
        for (const xa of xs) {
            for (let y = ya; y < ya + reach; y++) {
                for (let x = xa; x < xa + reach; x++) {
                    const at = y * stride + x * 4 + 3;
                    pixels[at] = Math.round(pixels[at] * coverage(x, y, box, r));
                }
            }
        }
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels), GdkPixbuf.Colorspace.RGB,
        true, 8, src.get_width(), src.get_height(), stride);
}

function load(path) {
    const info = GdkPixbuf.Pixbuf.get_file_info(path);
    const side = Math.max(info[1], info[2]);
    if (!(side > 0))
        return null;
    // Vector icons and small ones are drawn at a size that rounds cleanly.
    const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, side));
    if (side === size)
        return GdkPixbuf.Pixbuf.new_from_file(path);
    return GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, true);
}

// The icon file at path with its corners rounded by radius (percent of its
// side, 0 for none): the path of the rounded copy, or path itself when it
// has a shape of its own, can't be read, or radius is 0.
export function roundedIcon(path, radius) {
    if (!(radius > 0) || !path)
        return path;
    const stamp = fileStamp(path);
    if (stamp === null)
        return path;
    const key = `${path}\n${stamp}\n${radius}`;
    if (known.has(key))
        return known.get(key);

    const dir = cacheDir('rounded');
    const out = `${dir}/${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, key, -1)}.png`;
    // Made by an earlier session, or found not square then ("<out>.none").
    let result = exists(out) ? out : exists(`${out}.none`) ? path : null;
    if (result === null) {
        result = path;
        try {
            const pixbuf = load(path);
            const box = pixbuf && isSquare(pixbuf);
            GLib.mkdir_with_parents(dir, 0o755);
            if (box) {
                roundCorners(pixbuf, box, radius).savev(out, 'png', [], []);
                result = out;
            } else {
                GLib.file_set_contents(`${out}.none`, '');
            }
        } catch {}
    }
    known.set(key, result);
    return result;
}

export function forgetRounded() {
    known.clear();
}
