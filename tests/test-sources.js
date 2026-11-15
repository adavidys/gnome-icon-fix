import GLib from 'gi://GLib';

import {GAME_DIR, GAME_EXE, HOME, eq, ok, short, test} from './harness.js';
import {AppIndex, tryCall} from '../src/lib/appindex.js';
import {forgetBundles} from '../src/lib/bundle.js';
import {windowContext} from '../src/lib/matcher.js';
import {createSources, envKeys} from '../src/sources/registry.js';

const sources = createSources();
const S = name => sources.find(s => s.name === name);
const WGAME = `Z:${GAME_EXE.replace(/\//g, '\\')}`;

// A window context as matchWindow() builds it.
function ctx(hints) {
    const c = windowContext(hints);
    c.launcher = sources.find(s => (s.sandbox && s.sandbox === c.launcherSandbox) || tryCall(s, 'launched', c))?.name ?? null;
    return c;
}
const wine = (env = {}, extra = {}) => ctx({proc: {pid: 0, argv: [WGAME], exe: '/usr/bin/wine64-preloader', cwd: GAME_DIR, env}, ...extra});
const index = entries => new AppIndex(entries, sources);

test('registry: every source, and the variables they want', () => {
    eq(sources.map(s => s.name), ['heroic', 'steam', 'bottles', 'lutris', 'packaging', 'theme', 'exe']);
    const keys = envKeys(sources);
    for (const key of ['WINEPREFIX', 'HEROIC_APP_NAME', 'SteamAppId', 'BOTTLE', 'LUTRIS_GAME_UUID', 'APPIMAGE'])
        ok(keys.has(key), key);
});

test('packaging: Snap and AppImage', () => {
    const p = S('packaging');
    const appimage = `${HOME}/Applications/Foo-1.0.AppImage`;
    const idx = index([
        {id: 'spotify_spotify.desktop', exec: 'env BAMF=1 /snap/bin/spotify %U'},
        {id: 'fake_snap.desktop', exec: '/usr/bin/fake'},
        {id: 'foo.desktop', exec: `${appimage} --no-sandbox`},
        {id: 'bar.desktop', exec: 'bar-launcher', name: 'Bar'},
    ]);
    const proc = env => ctx({proc: {pid: 0, argv: ['/tmp/.mount/x'], exe: '/tmp/.mount/x', cwd: '/', env}});
    eq(p.identify(proc({SNAP_NAME: 'spotify'}), idx), {id: 'spotify_spotify.desktop'});
    eq(p.identify(proc({SNAP_INSTANCE_NAME: 'spotify', SNAP_NAME: 'other'}), idx), {id: 'spotify_spotify.desktop'});
    eq(p.identify(proc({SNAP_NAME: 'fake'}), idx), null, 'not a snap entry');
    eq(p.identify(proc({APPIMAGE: appimage}), idx), {id: 'foo.desktop'});
    eq(p.identify(proc({APPIMAGE: `${HOME}/Applications/bar-launcher.AppImage`}), idx), {id: 'bar.desktop'}, 'by name');
    eq(p.identify(proc({APPIMAGE: 'relative.AppImage'}), idx), null);
    // An AppImage a package runs through a script of its own.
    const wrapped = index([
        {id: 'binary.desktop', exec: `${HOME}/bin/binary`},
        {id: 'plain.desktop', exec: `${HOME}/bin/plain-script`},
        {id: 'huge.desktop', exec: `${HOME}/bin/huge`},
        {id: 'other.desktop', exec: `${HOME}/bin/other-script`},
        {id: 'gone.desktop', exec: `${HOME}/bin/gone`},
        {id: 'osu-lazer.desktop', exec: `${HOME}/bin/osu-lazer %u`},
    ]);
    eq(p.identify(proc({APPIMAGE: `${HOME}/opt/osu/osu.AppImage`}), wrapped), {id: 'osu-lazer.desktop'}, 'by its wrapper script');
    eq(p.identify(proc({APPIMAGE: `${HOME}/opt/osu/unknown.AppImage`}), wrapped), null);
    eq(p.identify(proc({APPIMAGE: `${HOME}/opt/osu/vanished.AppImage`}), wrapped), {id: 'other.desktop'}, 'by the path alone');
    // An icon named after the window or its program.
    const t = S('theme');
    eq(t.fallback(ctx({wmClass: 'osu!', wmInstance: 'Osu!', proc: {pid: 0, argv: ['/x/osu'], exe: '/x/osu', cwd: '/', env: {}}})),
        {iconName: ['osu!', 'Osu!', 'osu']});
    eq(t.fallback(ctx({})), null);
    eq(p.identify(proc({}), idx), null);
    eq(new AppIndex([{id: 'a_b.desktop', name: 'X'}], sources).map('snap').size, 0, 'no Exec');
    eq(p.identify(ctx({proc: {pid: 0, argv: [], exe: '/snap/spotify/85/usr/bin/spotify', cwd: '/', env: {}}}), idx),
        {id: 'spotify_spotify.desktop'}, 'a snap by the folder it runs from');
});

test('packaging: an AppImage whose environment is gone (Electron)', () => {
    const p = S('packaging');
    const mount = `${HOME}/tmp/.mount_Foo AbC`;
    const run = (pid = 100) => ctx({wmClass: 'FooClass', proc: {pid, argv: [`${mount}/foo`], exe: `${mount}/foo`, cwd: '/', env: {}}});
    // Nothing serves the fixture's mount in the real /proc: no image file.
    forgetBundles();
    eq(p.identify(run(), index([])), null, 'nothing on the host');
    const fallback = p.fallback(run());
    eq(fallback.name, 'Foo App', 'the bundle\'s own name');
    ok(fallback.icon.includes('/bundle-icons/'), 'and icon, kept outside the mount');
    // A host entry made from the bundle's own.
    const byClass = index([{id: 'foo-integrated.desktop', exec: '/opt/foo/foo', wmClass: 'fooclass'}]);
    eq(p.identify(run(), byClass), {id: 'foo-integrated.desktop'});
    const byIcon = index([{id: 'foo-pkg.desktop', exec: '/usr/bin/foo-pkg', icon: 'foo-icon'}]);
    eq(p.identify(run(), byIcon), {id: 'foo-pkg.desktop'});
    eq(p.fallback(ctx({proc: {pid: 0, argv: ['/usr/bin/true'], exe: '/usr/bin/true', cwd: '/', env: {}}})), null);
    eq(p.fallback(ctx({proc: {pid: 0, argv: [], exe: '/snap/x/1/x', cwd: '/', env: {}}})), null, 'nothing in it');
    const at = dir => ctx({proc: {pid: 0, argv: [], exe: `${HOME}/tmp/${dir}/x`, cwd: '/', env: {}}});
    eq(p.fallback(at('.mount_NoIcon')), {icon: null, name: 'No Icon'});
    eq(p.identify(at('.mount_NoIcon'), byIcon), null, 'an entry without class or icon');
    ok(p.fallback(at('.mount_Bare')).icon.endsWith('.svg'), 'no entry, an icon');
    eq(p.fallback(at('.mount_Bare')).name, null);
});

test('exe: entry icons and fallbacks', () => {
    const e = S('exe');
    const prefix = `${HOME}/.wine-game`;
    ok(e.entryIcon({}, ['env', `WINEPREFIX=${prefix}`, 'wine', 'C:\\Game\\game.exe']).includes('/exe-icons/'));
    ok(e.entryIcon({}, ['wine', WGAME]).includes('/exe-icons/'));
    ok(e.entryIcon({}, ['wine', GAME_EXE]).includes('/exe-icons/'));
    eq(e.entryIcon({}, ['wine', 'C:\\missing.exe']), null, 'default prefix, missing');
    eq(e.entryIcon({}, ['/usr/bin/x']), null);
    eq(e.entryIcon({}, ['wine']), null);
    eq(e.entryIcon({}, ['wine', `${GAME_DIR}/Broken.exe`]), null, 'not a program');
    eq(e.fallback(ctx({proc: {pid: 0, argv: ['/usr/bin/x'], exe: '/usr/bin/x', cwd: '/', env: {}}})), null, 'not Wine');
    eq(e.fallback(wine({})).name, 'Png Game', 'product name');
    eq(e.fallback(ctx({proc: {pid: 0, argv: [`Z:${GAME_DIR.replace(/\//g, '\\')}\\Tool "Pro".exe`], exe: '/usr/bin/wine', cwd: '/', env: {}}})).name, 'Thirty Two');
    eq(e.fallback(ctx({proc: {pid: 0, argv: [`${HOME}/.wine-game/drive_c/Game/game.exe`], exe: '/usr/bin/wine', cwd: '/', env: {}}})).name, 'game', 'file name');
    eq(e.fallback(ctx({proc: {pid: 0, argv: ['C:\\nope.exe'], exe: '/usr/bin/wine', cwd: '/', env: {}}})), null, 'no .exe');
    eq(e.fallback(ctx({proc: {pid: 0, argv: ['Z:\\missing\\x.exe'], exe: '/usr/bin/wine', cwd: '/', env: {}}})), null, '.exe gone');
    eq(e.fallback(ctx({proc: {pid: 0, argv: [`${GAME_DIR}/Broken.exe`], exe: '/usr/bin/wine', cwd: '/', env: {}}})), null, 'not a program');
});
