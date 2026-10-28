import GLib from 'gi://GLib';

import {GAME_DIR, HOME, eq, ok, short, test} from './harness.js';
import * as util from '../src/lib/util.js';

test('util: normalize, basename, stripExt, exeStem', () => {
    eq(util.normalize(null), '');
    eq(util.normalize('Half-Life: Source!'), 'halflifesource');
    eq(util.normalize('Ведьмак 3'), 'ведьмак3');
    eq(util.basename('C:\\Games\\Foo.exe'), 'Foo.exe');
    eq(util.basename('/opt/foo/'), 'foo');
    eq(util.basename(''), '');
    eq(util.stripExt('Game.EXE'), 'Game');
    eq(util.stripExt('run.x86_64'), 'run');
    eq(util.stripExt('notes.txt'), 'notes.txt');
    eq(util.exeStem('C:\\Games\\Some Game.exe'), 'some game');
});

test('util: canonical and the user folders', () => {
    eq(util.canonical(null), null);
    eq(util.canonical(42), null);
    eq(util.canonical('relative/path'), null);
    eq(util.canonical('/a//b/../c/'), '/a/c');
    eq(util.home('x', 'y'), `${HOME}/x/y`);
    eq(util.dataDir('z'), `${HOME}/.local/share/z`);
    eq(util.configDir('z'), `${HOME}/.config/z`);
});

test('util: files', () => {
    eq(util.exists(null), false);
    eq(util.exists(`${HOME}/missing`), false);
    eq(util.exists(GAME_DIR), true);
    eq(util.listDir(`${HOME}/missing`), []);
    ok(util.listDir(GAME_DIR).includes('Some Game.exe'));
    eq(util.readText(`${HOME}/missing`), null);
    ok(util.readText(`${HOME}/.config/heroic/GamesConfig/broken.json`).startsWith('not'));
    eq(util.readJson(`${HOME}/missing`), null);
    eq(util.readJson(`${HOME}/.config/heroic/GamesConfig/broken.json`), null);
    eq(util.readJson(`${HOME}/.config/heroic/GamesConfig/amzn1.json`), {amzn1: {}});
    eq(util.fileStamp(`${HOME}/missing`), null);
    // A folder we may list but not enter: names, but no file details.
    const closed = `${HOME}/closed`;
    GLib.mkdir_with_parents(closed, 0o755);
    GLib.file_set_contents(`${closed}/f`, 'x');
    GLib.chmod(closed, 0o644);
    eq(util.listDir(closed), ['f']);
    eq(util.fileStamp(`${closed}/f`), null);
    GLib.chmod(closed, 0o755);
    ok(/^\d+\.\d+:\d+$/.test(util.fileStamp(GAME_DIR)));
});

test('util: StampCache reloads only when the file changes', () => {
    const path = `${HOME}/stamp-test.txt`;
    let loads = 0;
    const cache = new util.StampCache(p => {
        loads++;
        const text = util.readText(p);
        if (text === 'throw')
            throw new Error('broken');
        return text;
    });
    eq(cache.get(path), null, 'missing file');
    GLib.file_set_contents(path, 'one');
    eq(cache.get(path), 'one');
    eq(cache.get(path), 'one');
    eq(loads, 1, 'cached');
    GLib.file_set_contents(path, 'two!');
    eq(cache.get(path), 'two!');
    GLib.file_set_contents(path, 'throw');
    eq(cache.get(path), null, 'a failing load gives null');
    GLib.unlink(path);
    eq(cache.get(path), null, 'deleted');
});

test('util: paths and folders', () => {
    eq(util.pathKey('/A/b'), '/a/b');
    eq([...util.selfAndParents('/a/b/c')], ['/a/b/c', '/a/b', '/a']);
    eq([...util.selfAndParents('/')], []);
    eq(util.isUnder('/a/b', '/a'), true);
    eq(util.isUnder('/a', '/a'), true);
    eq(util.isUnder('/ab', '/a'), false);
    eq(util.isSpecificDir(null), false);
    eq(util.isSpecificDir('/opt'), false, 'too shallow');
    eq(util.isSpecificDir(GLib.path_get_dirname(HOME)), false, 'holds the home folder');
    eq(util.isSpecificDir('/usr/share/foo'), false, 'system folder');
    eq(util.isSpecificDir(`${HOME}/Games`), false, 'shared folder name');
    eq(util.isSpecificDir(GAME_DIR), true);
    eq(util.isSpecificDir('/opt/some-app'), true);
});

test('util: hicolor icons, also inside launcher sandboxes', () => {
    const share = `${HOME}/.var/app/net.lutris.Lutris/data`;
    eq(util.findHicolorIcon(share, null), null);
    eq(short(util.findHicolorIcon(share, 'lutris_some-game')),
        '~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png');
    eq(util.findHicolorIcon(share, 'nope'), null);
    ok(util.LAUNCHER_SANDBOXES.has('com.usebottles.bottles'));
    eq(short(util.findSandboxedIcon('steam_icon_70')),
        '~/.var/app/com.valvesoftware.Steam/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png');
    eq(short(util.findSandboxedIcon('lutris_some-game')),
        '~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png');
    eq(util.findSandboxedIcon('nope'), null);
});
