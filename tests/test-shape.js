import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {HOME, eq, ok, test} from './harness.js';
import {DEFAULT_RADIUS, forgetRounded, isSquare, roundCorners, roundedIcon} from '../src/lib/shape.js';

const DIR = `${HOME}/shapes`;

// A w x h picture; alpha(x, y) gives each pixel's opacity (0-255).
function picture(name, w, h, alpha = () => 255, hasAlpha = true) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, hasAlpha, 8, w, h);
    pixbuf.fill(0x3366ccff);
    if (hasAlpha) {
        const stride = pixbuf.get_rowstride();
        const pixels = pixbuf.get_pixels();
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++)
                pixels[y * stride + x * 4 + 3] = alpha(x, y);
        }
        const out = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels), GdkPixbuf.Colorspace.RGB, true, 8, w, h, stride);
        GLib.mkdir_with_parents(DIR, 0o755);
        out.savev(`${DIR}/${name}.png`, 'png', [], []);
    } else {
        GLib.mkdir_with_parents(DIR, 0o755);
        pixbuf.savev(`${DIR}/${name}.png`, 'png', [], []);
    }
    return `${DIR}/${name}.png`;
}

const alphaAt = (path, x, y) => {
    const p = GdkPixbuf.Pixbuf.new_from_file(path);
    return p.get_pixels()[y * p.get_rowstride() + x * 4 + 3];
};

test('shape: which pictures are square', () => {
    const load = path => GdkPixbuf.Pixbuf.new_from_file(path);
    eq(isSquare(load(picture('full', 64, 64))), {x0: 0, y0: 0, x1: 63, y1: 63});
    eq(isSquare(load(picture('rgb', 64, 64, undefined, false))), {x0: 0, y0: 0, x1: 63, y1: 63}, 'no alpha at all');
    // A square with a transparent margin is rounded where it is.
    eq(isSquare(load(picture('padded', 64, 64, (x, y) => x >= 8 && x < 56 && y >= 8 && y < 56 ? 255 : 0))),
        {x0: 8, y0: 8, x1: 55, y1: 55});
    const circle = (x, y) => Math.hypot(x - 31.5, y - 31.5) < 30 ? 255 : 0;
    eq(isSquare(load(picture('circle', 64, 64, circle))), null, 'a shape of its own');
    eq(isSquare(load(picture('wide', 64, 32))), null, 'not square');
    eq(isSquare(load(picture('empty', 64, 64, () => 0))), null);
    eq(isSquare(load(picture('tiny', 4, 4))), null);
    // Rounded already, by a little: still square enough at three corners?
    eq(isSquare(load(picture('one-round', 64, 64, (x, y) => x < 6 && y < 6 ? 0 : 255))), {x0: 0, y0: 0, x1: 63, y1: 63},
        'one corner cut off');
});

test('shape: rounded corners', () => {
    const box = {x0: 0, y0: 0, x1: 99, y1: 99};
    const src = GdkPixbuf.Pixbuf.new_from_file(picture('hundred', 100, 100));
    const out = roundCorners(src, box, 20);
    const a = (x, y) => out.get_pixels()[y * out.get_rowstride() + x * 4 + 3];
    eq([a(0, 0), a(99, 0), a(0, 99), a(99, 99)], [0, 0, 0, 0], 'corners cut');
    eq([a(50, 0), a(0, 50), a(50, 50), a(20, 20)], [255, 255, 255, 255], 'edges and middle kept');
    ok(a(6, 5) > 0 && a(6, 5) < 255, `antialiased edge (${a(6, 5)})`);
    const rgb = roundCorners(GdkPixbuf.Pixbuf.new_from_file(picture('rgb2', 100, 100, undefined, false)), box, 20);
    eq(rgb.get_has_alpha(), true);
});

test('shape: rounded copies, cached', () => {
    forgetRounded();
    eq(DEFAULT_RADIUS, 16);
    const square = picture('icon', 64, 64);
    const rounded = roundedIcon(square, 16);
    ok(rounded !== square && rounded.includes('/.cache/icon-fix/rounded/'), rounded);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(rounded);
    eq([pixbuf.get_width(), pixbuf.get_height()], [128, 128], 'small icons are worked on bigger');
    eq(alphaAt(rounded, 0, 0), 0);
    eq(roundedIcon(square, 16), rounded, 'once');
    forgetRounded();
    eq(roundedIcon(square, 16), rounded, 'kept from an earlier session');
    const big = roundedIcon(picture('big', 512, 512), 10);
    eq(GdkPixbuf.Pixbuf.new_from_file(big).get_width(), 256, 'big ones smaller');
    eq(roundedIcon(picture('mid', 200, 200), 10).length > 0, true);
    const circle = picture('circle2', 64, 64, (x, y) => Math.hypot(x - 31.5, y - 31.5) < 30 ? 255 : 0);
    eq(roundedIcon(circle, 16), circle, 'left as it is');
    forgetRounded();
    eq(roundedIcon(circle, 16), circle, 'known not to be square from an earlier session');
    eq(roundedIcon(square, 0), square, 'off');
    eq(roundedIcon(null, 16), null);
    eq(roundedIcon(`${HOME}/nope.png`, 16), `${HOME}/nope.png`);
    GLib.file_set_contents(`${DIR}/broken.png`, 'not a png');
    eq(roundedIcon(`${DIR}/broken.png`, 16), `${DIR}/broken.png`, 'unreadable');
    // A header that reads, a picture that doesn't.
    const whole = GLib.file_get_contents(square)[1];
    GLib.file_set_contents(`${DIR}/cut.png`, whole.slice(0, 40));
    eq(roundedIcon(`${DIR}/cut.png`, 16), `${DIR}/cut.png`, 'cut short');
    // A cache it can't write to: the icon as it is.
    const cache = `${HOME}/.cache/icon-fix/rounded`;
    GLib.rename(cache, `${cache}.away`);
    GLib.file_set_contents(cache, 'in the way');
    try {
        const other = picture('other', 64, 64);
        eq(roundedIcon(other, 20), other);
    } finally {
        GLib.unlink(cache);
        GLib.rename(`${cache}.away`, cache);
    }
    GLib.file_set_contents(`${DIR}/empty.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"/>');
    eq(roundedIcon(`${DIR}/empty.svg`, 16), `${DIR}/empty.svg`, 'no size');
});
