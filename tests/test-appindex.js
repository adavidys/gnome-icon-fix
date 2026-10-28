import {GAME_DIR, HOME, eq, test} from './harness.js';
import {AppIndex, flavorOf, parseExec, tryCall} from '../src/lib/appindex.js';
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
    const map = index.map('lutris');
    eq(index.find(map, 'x', {launcherSandbox: null}), 'lutris-native.desktop');
    eq(index.find(map, 'x', {launcherSandbox: 'net.lutris.Lutris'}), 'lutris-flatpak.desktop');
    eq(index.find(map, 'x', {launcherSandbox: 'org.other'}), 'lutris-native.desktop', 'any flavor');
    eq(index.find(map, null, {}), null);
    eq(index.find(map, 'nope', {}), null);
    index.add(map, '', 'ignored.desktop');
    eq(map.has(''), false);
});
