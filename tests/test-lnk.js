import GLib from 'gi://GLib';

import {HOME, eq, ok, short, test} from './harness.js';
import {parseLnk, prefixOf, readLnk} from '../src/lib/lnk.js';
import {exeIcon} from '../src/lib/peicon.js';

const PREFIX = `${HOME}/.wine-game`;
const DESKTOP = `${PREFIX}/drive_c/users/x/Desktop`;
const GAME = `${PREFIX}/drive_c/Game/game.exe`;

test('lnk: what a shortcut points at', () => {
    eq(readLnk(`${PREFIX}/drive_c/users/x/Start Menu/Launcher.lnk`), {program: GAME, icon: null}, 'as Wine writes them');
    eq(readLnk(`${DESKTOP}/Wide.lnk`), {program: GAME, icon: GAME}, 'UTF-16 paths, a target ID list, every string');
    eq(readLnk(`${DESKTOP}/Root.lnk`).program, GAME, 'a base path ending in \\');
    eq(readLnk(`${DESKTOP}/Relative.lnk`).program, GAME, 'only a relative path');
    eq(readLnk(`${DESKTOP}/Ansi.lnk`), {program: GAME, icon: `${PREFIX}/drive_c/Game/game.ico`}, 'no UTF-16 at all');
    eq(readLnk(`${DESKTOP}/Env.lnk`), null, 'environment variables');
    eq(readLnk(`${DESKTOP}/Network.lnk`), null, 'on a network share');
    for (const name of ['Truncated', 'Unterminated', 'Huge', 'NotLnk', 'Missing'])
        eq(readLnk(`${DESKTOP}/${name}.lnk`), null, name);
    // Another prefix than the one it lies in.
    eq(readLnk(`${DESKTOP}/Launcher.lnk`, `${HOME}/.wine`), null);
    eq(readLnk(`${PREFIX}/drive_c/users/x/Start Menu/Launcher.lnk`, `${HOME}/.wine`), null, 'C: not in that prefix');
});

test('lnk: the raw format', () => {
    const bytes = GLib.file_get_contents(`${DESKTOP}/Wide.lnk`)[1];
    eq(parseLnk(bytes), {target: 'C:\\Game\\game.exe', relativePath: null, workingDir: null, arguments: '-x',
        iconLocation: 'C:\\Game\\game.exe', iconIndex: 0});
    eq(parseLnk(GLib.file_get_contents(`${DESKTOP}/Dll.lnk`)[1]).iconIndex, 3);
    eq(parseLnk(GLib.file_get_contents(`${DESKTOP}/Ico.lnk`)[1]).workingDir, 'C:\\Game', 'a NUL counted in');
    eq(parseLnk(new Uint8Array(10)), null);
    eq(prefixOf(GAME), PREFIX);
    eq(prefixOf(`${PREFIX}/drive_c`), PREFIX);
    eq(prefixOf('/opt/x.lnk'), null);
});

test('lnk: icons of shortcuts', () => {
    const fromExe = short(exeIcon(GAME));
    ok(fromExe.includes('/exe-icons/'));
    eq(short(exeIcon(`${PREFIX}/drive_c/users/x/Start Menu/Launcher.lnk`)), fromExe, 'its program\'s');
    eq(short(exeIcon(`${DESKTOP}/Wide.lnk`)), fromExe, 'the program it names');
    eq(exeIcon(`${DESKTOP}/Ico.lnk`), `${PREFIX}/drive_c/Game/game.ico`, 'an .ico');
    eq(short(exeIcon(`${DESKTOP}/GoneIco.lnk`)), fromExe, 'its .ico gone');
    eq(short(exeIcon(`${DESKTOP}/Dll.lnk`)), fromExe, 'not a system library\'s');
    eq(exeIcon(`${DESKTOP}/NotLnk.lnk`), null);
});
