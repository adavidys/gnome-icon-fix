import {GAME_DIR, HOME, eq, test} from './harness.js';
import {matchWindow, windowContext} from '../src/lib/matcher.js';
import {AppIndex, flavorOf, parseExec, tryCall, wineKey} from '../src/lib/appindex.js';
import {createSources} from '../src/sources/registry.js';

test('appindex: tryCall survives broken sources', () => {
    const source = {name: 'broken', boom() {
        throw new Error('boom');
    }, fine: x => x + 1, nothing: () => undefined};
    eq(tryCall(source, 'boom'), null);
    eq(tryCall(source, 'fine', 1), 2);
    eq(tryCall(source, 'nothing'), null);
    eq(tryCall(source, 'missing'), null);
});

test('appindex: parseExec and flavors', () => {
    eq(parseExec(null), []);
    eq(parseExec('foo "a b" %U --x=%f'), ['foo', 'a b', '--x=']);
    eq(parseExec('foo "unterminated'), []);
    eq(flavorOf({launcherSandbox: 'Net.Lutris.Lutris'}), 'net.lutris.lutris');
    eq(flavorOf({launcherSandbox: null}), 'native');
    eq(flavorOf({}), 'native');
    const index = new AppIndex([
        {id: 'a.desktop', exec: 'flatpak run --branch=stable Org.Example.App'},
        {id: 'b.desktop', exec: '/usr/bin/b'},
        {id: 'c.desktop', exec: null},
    ]);
    eq([...index.flavor], [['a.desktop', 'org.example.app'], ['b.desktop', 'native'], ['c.desktop', 'native']]);
});

test('appindex: tables, owners, folders, flavored lookups', () => {
    const index = new AppIndex([
        {id: 'org.gnome.Foo.desktop', name: 'Foo', wmClass: 'FooClass', exec: '/usr/bin/foo %U', icon: 'org.gnome.Foo'},
        {id: 'dup.desktop', name: 'Foo', exec: '/usr/bin/foo2', icon: '/abs/icon.png'},
        {id: 'game.desktop', name: 'Some Game', exec: `"${GAME_DIR}/Some Game.exe"`, icon: null},
        {id: 'run-a.desktop', name: 'A', exec: `${HOME}/scripts/run-a.sh`},
        {id: 'run-b.desktop', name: 'B', exec: `${HOME}/scripts/run-b.sh`},
        {id: 'path.desktop', name: 'P', exec: 'start-p', path: `${HOME}/Apps/P`},
        {id: 'flatpak-app.desktop', name: 'F', exec: 'flatpak run org.Foo.App'},
        {id: 'lutris-native.desktop', name: 'X', exec: 'lutris lutris:rungame/x'},
        {id: 'lutris-flatpak.desktop', name: 'X', exec: 'flatpak run net.lutris.Lutris lutris:rungame/x'},
        {id: 'relative.desktop', name: 'R', exec: 'relative/prog'},
        {id: 'noexec.desktop', name: 'N'},
        {id: 'iconned.desktop', name: 'I', exec: '/usr/bin/i', icon: 'custom-icon-name'},
    ], createSources());
    eq(index.lookup('custom-icon-name'), 'iconned.desktop', 'by icon name');
    eq(new AppIndex([{id: 'a.desktop', name: 'A'}]).lookup('a'), 'a.desktop', 'no sources');
    eq(index.lookup('FooClass'), 'org.gnome.Foo.desktop', 'by class');
    eq(index.lookup('org.gnome.foo'), 'org.gnome.Foo.desktop', 'by id');
    eq(index.lookup('Foo'), 'org.gnome.Foo.desktop', 'by short id');
    eq(index.lookup('foo2'), 'dup.desktop', 'by program');
    eq(index.lookup('org.gnome.Foo'), 'org.gnome.Foo.desktop', 'by icon');
    eq(index.lookup('some-game'), 'game.desktop', 'by name');
    eq(index.lookup('nothing'), null);
    eq(index.lookup(null), null);
    eq(index.exactPath([`${GAME_DIR}/Some Game.exe`]), 'game.desktop');
    eq(index.exactPath(['/nope']), null);
    eq(index.nearestDir([`${GAME_DIR}/sub/file`]), 'game.desktop');
    eq(index.nearestDir([`${HOME}/Apps/P/bin`]), 'path.desktop', 'Path= folder');
    eq(index.nearestDir([`${HOME}/scripts/x`]), null, 'shared by two entries');
    eq(index.lookup('org.foo.app'), 'flatpak-app.desktop', 'flatpak app id');
    eq(index.owner.get('lutris-native.desktop'), 'lutris');
    eq(index.owner.get('game.desktop'), undefined);
    // A source's own keys, kept per flavor too.
    const keyed = {name: 'keyed', indexEntry: (e, _argv, idx) => {
        idx.add(idx.map('keyed'), 'x', e.id);
        return true;
    }};
    const flavored = new AppIndex([
        {id: 'native.desktop', exec: 'tool run x'},
        {id: 'flatpak.desktop', exec: 'flatpak run org.Tool.App run x'},
    ], [keyed]);
    const map = flavored.map('keyed');
    eq(flavored.find(map, 'x', {launcherSandbox: null}), 'native.desktop');
    eq(flavored.find(map, 'x', {launcherSandbox: 'org.tool.app'}), 'flatpak.desktop');
    eq(flavored.find(map, 'x', {launcherSandbox: 'org.other'}), 'native.desktop', 'any flavor');
    eq(flavored.find(map, 'x', {launcherSandbox: 'org.other'}, true), null, 'its own flavor only');
    eq(flavored.find(map, null, {}), null);
    eq(flavored.find(map, 'nope', {}), null);
    flavored.add(map, '', 'ignored.desktop');
    eq(map.has(''), false);
});

test('appindex: entries that only stand for something else', () => {
    const idx = new AppIndex([
        {id: 'discord-1216669957799018608.desktop', name: 'Game 1216669957799018608', exec: '/opt/osu/osu %u',
            noDisplay: true, mimeType: 'x-scheme-handler/discord-1216669957799018608'},
        {id: 'mount.desktop', name: 'Mounted', exec: '"/tmp/.mount_osu.Ab12/usr/bin/osu!" %u'},
        {id: 'hidden.desktop', name: 'Hidden', exec: '/opt/hidden/run', noDisplay: true, mimeType: 'text/plain;x-scheme-handler/h;'},
        {id: 'handler.desktop', name: 'Handler', exec: '/opt/handler/run', mimeType: 'x-scheme-handler/x'},
        {id: 'nodisplay.desktop', name: 'No Display', exec: '/opt/nd/run', noDisplay: true},
    ]);
    eq(idx.lookup('osu'), null, 'a hidden URI handler');
    eq(idx.name.get('mounted'), undefined, 'run from an AppImage\'s mount');
    eq(idx.lookup('run'), 'hidden.desktop', 'hidden, but not only a handler');
    eq(idx.name.get('handler'), 'handler.desktop', 'a handler shown in the app grid');
    eq(idx.program.get('handler.desktop'), '/opt/handler/run');
    eq(idx.name.get('nodisplay'), 'nodisplay.desktop', 'hidden, no types');
});

test('appindex: programs run through Wine, by prefix and name', () => {
    const prefix = `${HOME}/.wine-game`;
    const sources = createSources();
    const idx = new AppIndex([
        {id: 'game.desktop', exec: `env WINEPREFIX="${prefix}" wine C:\\\\Game\\\\game.exe`},
        {id: 'lnk.desktop', exec: `env WINEPREFIX=${prefix} wine start /unix ${prefix}/drive_c/users/x/Start\\ Menu/Other\\ Game.lnk`},
        {id: 'elsewhere.desktop', exec: `env WINEPREFIX=${prefix} wine start "Q:\\\\x\\\\Y.lnk"`},
        {id: 'launcher.desktop', exec: `env WINEPREFIX=${prefix} wine start /unix "${prefix}/drive_c/users/x/Start Menu/Launcher.lnk"`},
        {id: 'default.desktop', exec: 'wine "C:\\\\Program Files\\\\App\\\\app.exe"'},
        {id: 'bare.desktop', exec: 'wine'},
        {id: 'no-wine.desktop', exec: '/usr/bin/x'},
    ], sources);
    eq(['game.desktop', 'bare.desktop', 'no-wine.desktop'].map(id => idx.windows.has(id)), [true, false, false]);
    eq(idx.wine.get(wineKey(prefix, 'Launcher')), 'launcher.desktop', 'a .lnk by its own name');
    eq(idx.wine.get(wineKey(prefix, 'game')), 'game.desktop', 'and by its program, the first one');
    eq(idx.exec.get('launcher'), 'launcher.desktop');
    eq(idx.exec.get('y'), 'elsewhere.desktop', 'a shortcut on a drive the prefix doesn\'t have');
    const run = (argv, env) => matchWindow(idx, sources, {proc: {pid: 0, argv, exe: '/usr/bin/wine64-preloader', cwd: '/', env}}).primary;
    eq(run(['C:\\Game\\game.exe'], {WINEPREFIX: prefix}), {id: 'game.desktop', by: 'Wine program', exact: true});
    eq(run(['C:\\x\\OtherGame.exe'], {WINEPREFIX: prefix}).id, 'lnk.desktop', '.lnk named like the .exe');
    eq(run(['C:\\Program Files\\App\\app.exe'], {}).id, 'default.desktop', 'default prefix');
    eq(run(['C:\\nope.exe'], {WINEPREFIX: prefix}), null);
    eq(windowContext({proc: {pid: 0, argv: ['/usr/bin/x'], exe: '/usr/bin/x', cwd: '/', env: {}}}).wine, false);
});
