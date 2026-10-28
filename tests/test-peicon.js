import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {HOME, PE, eq, ok, test} from './harness.js';
import {exeInfo} from '../src/lib/peicon.js';

const OUT = `${HOME}/peicon-out`;

// [width, height, [r, g, b, a] at top-left, at bottom-right]
function look(info) {
    if (!info?.icon)
        return null;
    const p = GdkPixbuf.Pixbuf.new_from_file(info.icon);
    const at = (x, y) => [...p.get_pixels().slice(y * p.get_rowstride() + x * 4, y * p.get_rowstride() + x * 4 + 4)];
    return [p.get_width(), p.get_height(), at(0, 0), at(p.get_width() - 1, p.get_height() - 1)];
}

test('peicon: icons of every supported kind, names from version info', () => {
    const red = [255, 0, 0, 255];
    const blue = [0, 0, 255, 255];
    const clear = [255, 0, 0, 0];
    const cases = {
        'png.exe': ['Png Game', [256, 256, [200, 30, 60, 255], [200, 30, 60, 255]]],
        'pe32.exe': ['Thirty Two', [48, 48, red, blue]],
        'bmp24.exe': [null, [16, 16, clear, blue]],
        'bmp8.exe': [null, [16, 16, clear, blue]],
        'bmp8-colors.exe': [null, [16, 16, clear, blue]],
        'bmp4.exe': [null, [16, 16, clear, blue]],
        'bmp1.exe': [null, [16, 16, clear, blue]],
        'bmp32-noalpha.exe': [null, [16, 16, clear, blue]],
        'fallback.exe': [null, [32, 32, red, blue]],
        'named.exe': [null, [32, 32, red, blue]],
        'bigpng.exe': [null, [256, 1, [200, 30, 60, 255], [200, 30, 60, 255]]],
        'versiononly.exe': ['Described', null],
        'noimage.exe': ['Name Only', null],
        'novalue.exe': [null, null],
        'bigbmp.exe': [null, null],
        'cycle.exe': [null, null],
        'huge.exe': [null, null],
        'empty-rsrc.exe': [null, null],
        'oddbmps.exe': [null, null],
        'tie.exe': [null, [16, 16, red, blue]],
        'emptytype.exe': [null, null],
        'outrange.exe': [null, null],
        'before.exe': [null, null],
        'many.exe': [null, null],
    };
    for (const [file, [name, picture]] of Object.entries(cases)) {
        const info = exeInfo(`${PE}/${file}`, OUT);
        eq(info?.name ?? null, name, `${file} name`);
        eq(look(info), picture, `${file} icon`);
    }
});

test('peicon: not programs', () => {
    for (const file of ['notpe.exe', 'notmz.exe', 'norsrc.exe', 'outside.exe', 'below.exe', 'oddmagic.exe', 'truncated.exe'])
        eq(exeInfo(`${PE}/${file}`, OUT), null, file);
    eq(exeInfo(`${PE}/notpe.exe`, OUT), null, 'cached');
    eq(exeInfo(`${PE}/missing.exe`, OUT), null);
    eq(exeInfo(PE, OUT), null, 'a folder');
    const locked = `${HOME}/locked.exe`;
    GLib.file_set_contents(locked, 'MZ');
    GLib.chmod(locked, 0);
    eq(exeInfo(locked, OUT), null, 'can\'t be opened');
});

test('peicon: results are cached until the file or its PNG changes', () => {
    const exe = `${HOME}/cache-test.exe`;
    GLib.file_set_contents(exe, GLib.file_get_contents(`${PE}/png.exe`)[1]);
    const first = exeInfo(exe, OUT);
    ok(first.icon.startsWith(OUT));
    eq(exeInfo(exe, OUT), first, 'cached');
    // The PNG was cleaned up (a mirror switched off): extracted again.
    GLib.unlink(first.icon);
    eq(exeInfo(exe, OUT).icon, first.icon);
    ok(GLib.file_test(first.icon, GLib.FileTest.EXISTS));
    // The same folder spelled differently: its PNG is already there.
    eq(exeInfo(exe, `${OUT}/.`).icon, `${OUT}/.${first.icon.slice(OUT.length)}`);
    // Another folder gets its own copy; the default folder is the cache.
    ok(exeInfo(exe, `${OUT}2`).icon.startsWith(`${OUT}2/`));
    ok(exeInfo(exe).icon.startsWith(`${HOME}/.cache/icon-fix/exe-icons/`));
    // The program changes: read again.
    GLib.file_set_contents(exe, GLib.file_get_contents(`${PE}/pe32.exe`)[1]);
    eq(exeInfo(exe, OUT).name, 'Thirty Two');
    // A cached "no icon" stays without a stat of the PNG.
    eq(exeInfo(`${PE}/noimage.exe`, OUT).icon, null);
    eq(exeInfo(`${PE}/noimage.exe`, OUT).icon, null);
});
