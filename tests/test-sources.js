import GLib from 'gi://GLib';

import {GAME_DIR, GAME_EXE, HOME, eq, ok, short, test} from './harness.js';
import {AppIndex, tryCall} from '../src/lib/appindex.js';
import {windowContext} from '../src/lib/matcher.js';
import {bottleFromConfig, parseBottlesExec} from '../src/sources/bottles.js';
import {gamePrefix, installedGames} from '../src/sources/heroic.js';
import {gameFromConfig} from '../src/sources/lutris.js';
import {createSources, envKeys} from '../src/sources/registry.js';
import {readShortcuts, shortcutFiles, shortcutLook} from '../src/sources/steam.js';

const sources = createSources();
const S = name => sources.find(s => s.name === name);
const BOTTLE = `${HOME}/.var/app/com.usebottles.bottles/data/bottles/bottles/SomeBottle`;
const NATIVE_BOTTLE = `${HOME}/.local/share/bottles/bottles/SomeBottle`;
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
    eq(sources.map(s => s.name), ['heroic', 'steam', 'bottles', 'lutris', 'wine', 'packaging', 'exe']);
    const keys = envKeys(sources);
    for (const key of ['WINEPREFIX', 'HEROIC_APP_NAME', 'SteamAppId', 'BOTTLE', 'LUTRIS_GAME_UUID', 'APPIMAGE'])
        ok(keys.has(key), key);
});

test('heroic: installed games of every store', () => {
    eq(installedGames(null), []);
    eq(installedGames([null]), []);
    eq(gamePrefix('a', {b: 1}), null);
    eq(installedGames([{id: 'a', path: GAME_DIR}, {id: 'b', path: '/usr/bin'}, {path: GAME_DIR}]),
        [{appName: 'a', title: null, dir: GAME_DIR.toLowerCase(), exe: null}]);
    eq(installedGames({installed: [{appName: 7, install_path: GAME_DIR}]}).map(g => g.appName), ['7']);
    eq(installedGames({games: [{app_name: 's', title: 'T', install: {executable: GAME_EXE}}]}),
        [{appName: 's', title: 'T', dir: GAME_DIR.toLowerCase(), exe: GAME_EXE}]);
    eq(installedGames({x: {app_name: 'x', install_path: GAME_DIR, executable: 'Some Game.exe'}})[0].exe, GAME_EXE);
    eq(installedGames({x: {app_name: 'x', install: {executable: 5}}}), []);
    eq(gamePrefix('a', {a: {winePrefix: `${HOME}/P/`}}), `${HOME}/P`.toLowerCase());
    eq(gamePrefix('a', {a: {}}), null);
    eq(gamePrefix('a', null), null);
});

test('heroic: shortcuts, launch detection, games', () => {
    const h = S('heroic');
    const idx = index([
        {id: 'h1.desktop', exec: 'xdg-open heroic://launch/legendary/epicgame'},
        {id: 'h2.desktop', exec: 'heroic heroic://launch/abc123'},
        {id: 'h3.desktop', exec: 'xdg-open "heroic://launch?appName=Some%20Name&runner=gog"'},
        {id: 'h4.desktop', exec: 'xdg-open heroic://launch?appName=%E0%A4%A&runner=x'},
        {id: 'other.desktop', exec: '/usr/bin/other'},
    ]);
    const map = idx.map('heroic');
    eq(['epicgame', 'abc123', 'Some Name', '%E0%A4%A'].map(k => map.get(k)), ['h1.desktop', 'h2.desktop', 'h3.desktop', 'h4.desktop']);
    eq(idx.owner.get('other.desktop'), undefined);

    const byEnv = wine({HEROIC_APP_NAME: 'abc123'});
    eq(h.launched(byEnv), true);
    eq(h.identify(byEnv, idx), {id: 'h2.desktop'});
    eq(h.fallback(byEnv), {icon: null, name: 'Some Game (Heroic)'});
    const unknownEnv = wine({HEROIC_APP_NAME: 'unknown'});
    eq(h.identify(unknownEnv, idx), null);
    eq(h.fallback(unknownEnv), null, 'nothing known about it');
    eq(h.fallback(wine({HEROIC_APP_NAME: 'epicgame'})).name, 'Epic Game');

    const prefix = `${HOME}/Games/Heroic/Prefixes/Some Game`;
    const byPrefix = wine({WINEPREFIX: `${prefix}/pfx`});
    eq(h.launched(byPrefix), true, 'Proton prefix');
    eq(h.identify(byPrefix, idx), {id: 'h2.desktop'});
    eq(h.launched(wine({STEAM_COMPAT_DATA_PATH: prefix, WINEPREFIX: '/elsewhere'})), true, 'compat data path');
    // A prefix shared by two games: the folder decides.
    const shared = `${HOME}/Games/Heroic/Prefixes/Shared`;
    const gog = ctx({proc: {pid: 0, argv: ['C:\\x.exe'], exe: '/usr/bin/wine', cwd: `${HOME}/Games/GOG/Gog Game`, env: {WINEPREFIX: shared}}});
    eq(h._game(gog).appName, '1207');
    eq(h.fallback(ctx({proc: {pid: 0, argv: ['C:\\x.exe'], exe: '/usr/bin/wine', cwd: `${HOME}/Games/Epic/Epic Game`, env: {WINEPREFIX: shared}}})).icon.endsWith('/icons/epicgame.jpg'), true);
    eq(h._game(ctx({proc: {pid: 0, argv: ['C:\\x.exe'], exe: '/usr/bin/wine', cwd: '/', env: {WINEPREFIX: shared}}})), null, 'shared, no folder');
    // Heroic's Flatpak config folder gone: its prefixes simply aren't known.
    const flatConfigs = `${HOME}/.var/app/com.heroicgameslauncher.hgl/config/heroic/GamesConfig`;
    GLib.rename(flatConfigs, `${flatConfigs}.off`);
    eq(h.launched(wine({WINEPREFIX: `${HOME}/Games/Heroic/Prefixes/Flat/pfx`})), false);
    GLib.rename(`${flatConfigs}.off`, flatConfigs);
    eq(h.launched(wine({WINEPREFIX: `${HOME}/Games/Heroic/Prefixes/Flat/pfx`})), true);
    // Its files listed but unreadable (as if removed meanwhile): skipped.
    GLib.chmod(flatConfigs, 0o644);
    eq(h.launched(wine({WINEPREFIX: `${HOME}/Games/Heroic/Prefixes/Flat/pfx`})), false);
    GLib.chmod(flatConfigs, 0o755);

    // No signal but the folder (no launcher known): a guess.
    const byFolder = wine({});
    eq(h.launched(byFolder), false);
    eq(h._game(byFolder).appName, 'abc123');
    eq(h._game(byFolder), h._game(byFolder), 'cached on the context');
    // Another launcher's game: no folder guess.
    eq(h._game(wine({}, {launcherSandbox: 'net.lutris.Lutris'})), null);
    eq(h._game(ctx({proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}})), null, 'nothing to go on');
    eq(h.fallback(ctx({proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}})), null);
});

test('heroic: entry icons', () => {
    const h = S('heroic');
    eq(short(h.entryIcon({exec: 'xdg-open heroic://launch/legendary/epicgame'})), '~/.config/heroic/icons/epicgame.jpg');
    eq(short(h.entryIcon({exec: 'xdg-open heroic://launch/abc123'})), '~/.cache/icon-fix/exe-icons/<sha1>.png', 'from the .exe');
    eq(h.entryIcon({exec: 'xdg-open heroic://launch/nofolder'}), null, '.exe gone');
    eq(short(h.entryIcon({exec: 'xdg-open "heroic://launch?appName=abc123&runner=sideload"'})), '~/.cache/icon-fix/exe-icons/<sha1>.png');
    eq(h.entryIcon({exec: 'xdg-open heroic://launch/1207'}), null, 'no .exe known');
    eq(h.entryIcon({exec: 'xdg-open heroic://launch/brokenexe'}), null, 'not a program');
    eq(h.entryIcon({exec: 'xdg-open heroic://launch/unknown'}), null);
    eq(h.entryIcon({exec: '/usr/bin/other'}), null);
    eq(h.entryIcon({}), null);
});

test('lutris: configs, shortcuts, games', () => {
    const l = S('lutris');
    eq(gameFromConfig('/x/some-game-17.yml', {game: {exe: GAME_EXE, prefix: `${HOME}/p/`}}),
        {slug: 'some-game', stem: 'some game', prefix: `${HOME}/p`, dir: GAME_DIR.toLowerCase(), exe: GAME_EXE});
    eq(gameFromConfig('/x/a-1.yaml', {game: {working_dir: GAME_DIR}}).dir, GAME_DIR.toLowerCase());
    eq(gameFromConfig('/x/a.yml', {}), {slug: 'a', stem: null, prefix: null, dir: null, exe: null});

    const idx = index([
        {id: 'net.lutris.some-game-1.desktop', exec: 'env LUTRIS_SKIP_INIT=1 lutris lutris:rungameid/1'},
        {id: 'x.desktop', exec: 'lutris lutris:rungame/other-game'},
        {id: 'y.desktop', exec: 'lutris lutris:rungameid/9', icon: 'lutris_plain-game'},
        {id: 'z.desktop', exec: 'lutris lutris:rungameid/10'},
        {id: 'z2.desktop', exec: 'lutris lutris:rungameid/11', icon: 'not-lutris'},
        {id: 'w.desktop', exec: '/usr/bin/other'},
    ]);
    const map = idx.map('lutris');
    eq(['some-game', 'other-game', 'plain-game'].map(k => map.get(k)), ['net.lutris.some-game-1.desktop', 'x.desktop', 'y.desktop']);
    eq(idx.owner.get('z.desktop'), 'lutris', 'claimed without a slug');
    eq(idx.owner.get('z2.desktop'), 'lutris');
    eq(idx.owner.get('w.desktop'), undefined);

    const native = wine({LUTRIS_GAME_UUID: 'u', GAME_NAME: 'Named', WINEPREFIX: `${HOME}/Games/lutris-pfx`});
    eq(l.launched(native), true);
    eq(l.identify(native, idx), {id: 'net.lutris.some-game-1.desktop'});
    eq(l.fallback(native), {iconName: 'lutris_some-game', icon: `${HOME}/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png`, name: 'Named'});
    eq(l.launched(wine({WINEPREFIX: `${HOME}/Games/lutris-flat`})), true, 'prefix only');
    eq(l.launched(wine({})), false);
    const other = ctx({proc: {pid: 0, argv: ['/x/y'], exe: '/x/y', cwd: `${HOME}/Games/Other Game`, env: {}}});
    eq(l.identify(other, idx), {id: 'x.desktop'}, 'by working folder');
    eq(l.fallback(other).name, null);
    eq(l._game(other), l._game(other), 'cached');
    eq(l.identify(ctx({proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}}), idx), null);
    eq(l.fallback(ctx({proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}})), null);
    eq(l._game(wine({}, {launcherSandbox: 'com.heroicgameslauncher.hgl'})), null, 'another launcher\'s game');
});

test('lutris: entry icons', () => {
    const l = S('lutris');
    eq(short(l.entryIcon({id: 'x.desktop', exec: 'lutris lutris:rungame/other-game'})), '~/.local/share/icons/hicolor/128x128/apps/lutris_other-game.png');
    eq(short(l.entryIcon({id: 'net.lutris.some-game-3.desktop', exec: 'lutris lutris:rungameid/3'})),
        '~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png');
    eq(short(l.entryIcon({id: 'x.desktop', exec: 'lutris lutris:rungame/plain-game'})), '~/.cache/icon-fix/exe-icons/<sha1>.png');
    eq(l.entryIcon({id: 'x.desktop', exec: 'lutris lutris:rungame/unknown'}), null);
    eq(l.entryIcon({id: 'x.desktop', exec: 'lutris lutris:rungame/gone-game'}), null, '.exe gone');
    eq(l.entryIcon({id: 'x.desktop', exec: 'lutris lutris:rungame/broken-game'}), null, 'not a program');
    eq(l.entryIcon({id: 'x.desktop', exec: 'lutris lutris:rungameid/3'}), null, 'no slug');
    eq(l.entryIcon({id: 'x.desktop', exec: '/usr/bin/x'}), null);
});

test('bottles: launch lines and configs', () => {
    eq(parseBottlesExec(['bottles-cli', 'run', '-p', 'P', '-b', 'B', '--', '-p', 'X']), {program: 'P', bottle: 'B'});
    eq(parseBottlesExec(['flatpak', 'run', '--command=bottles-cli', 'com.usebottles.bottles', 'run', '--program=P', '--bottle=B']),
        {program: 'P', bottle: 'B'});
    eq(parseBottlesExec(['/usr/bin/bottles', '-e', 'C:\\G.exe', '-b', 'B', '--other']), {executable: 'C:\\G.exe', bottle: 'B'});
    eq(parseBottlesExec(['bottles-cli', 'run', '-p', 'P']), null, 'no bottle');
    eq(parseBottlesExec(['foo', '-b', 'B']), null);
    eq(bottleFromConfig({}), {name: null, programs: []});
    const config = bottleFromConfig({Name: 'N', External_Programs: {a: {name: 'A', executable: 'A.exe', path: '/g/A.exe', removed: 'true'}, b: {name: 'B', path: 'rel/B.exe'}, c: {name: 'C'}, d: null}});
    eq(config, {name: 'N', programs: [{name: 'A', stem: 'a', path: '/g/A.exe', removed: true}, {name: 'B', stem: 'b', path: null, removed: false}]});
});

test('bottles: shortcuts, launch detection, games', () => {
    const b = S('bottles');
    const idx = index([
        {id: 'by-name.desktop', exec: 'flatpak run --command=bottles-cli com.usebottles.bottles run -p "Some Game" -b "Some Bottle"'},
        {id: 'by-path.desktop', exec: `bottles-cli run -p "Tool \\"Pro\\" & Co" -b "${BOTTLE}/"`},
        {id: 'by-exe.desktop', exec: 'bottles -e "C:\\\\Games\\\\Other.exe" -b SomeBottle'},
        {id: 'not.desktop', exec: '/usr/bin/x'},
    ]);
    const flat = wine({WINEPREFIX: BOTTLE});
    eq(b.launched(flat), true, 'its prefix is a bottle');
    eq(b.identify(flat, idx), {id: 'by-name.desktop'});
    eq(b.fallback(flat), {icon: `${BOTTLE}/icons/Some Game.png`, name: 'Some Game'});
    const tool = ctx({proc: {pid: 0, argv: ['Z:\\x\\Tool "Pro".exe'], exe: '/usr/bin/wine', cwd: '/', env: {WINEPREFIX: BOTTLE}}});
    eq(b.identify(tool, idx), {id: 'by-path.desktop'}, 'by the bottle\'s path');
    const other = ctx({proc: {pid: 0, argv: ['C:\\Games\\Other.exe'], exe: '/usr/bin/wine', cwd: '/', env: {WINEPREFIX: BOTTLE}}});
    eq(b.identify(other, idx), {id: 'by-exe.desktop'}, 'by folder name and .exe');
    eq(b.fallback(other), null, 'not a program of the bottle');
    eq(b.identify(ctx({proc: {pid: 0, argv: ['C:\\nope.exe'], exe: '/usr/bin/wine', cwd: '/', env: {WINEPREFIX: BOTTLE}}}), idx), null);
    eq(b.launched(wine({BOTTLE: 'x'})), true);
    eq(b.launched(wine({})), false);
    eq(b.identify(wine({}), idx), null);
    eq(b.fallback(wine({})), null);
});

test('bottles: entry icons', () => {
    const b = S('bottles');
    const argv = (bottle, program, flatpak = true) => [...flatpak ? ['flatpak', 'run', '--command=bottles-cli', 'com.usebottles.bottles'] : ['bottles-cli'], 'run', '-p', program, '-b', bottle];
    eq(b.entryIcon({}, argv('Some Bottle', 'Some Game')), `${BOTTLE}/icons/Some Game.png`, 'Flatpak entry: Flatpak bottle');
    eq(b.entryIcon({}, argv('Some Bottle', 'Some Game', false)), `${NATIVE_BOTTLE}/icons/Some Game.png`, 'native entry: native bottle');
    eq(b.entryIcon({}, argv('SomeBottle', 'Some Game')), `${BOTTLE}/icons/Some Game.png`, 'by folder name');
    eq(b.entryIcon({}, argv(BOTTLE, 'Some Game')), `${BOTTLE}/icons/Some Game.png`, 'by path');
    eq(short(b.entryIcon({}, argv(BOTTLE, 'Tool "Pro" & Co'))), '~/.cache/icon-fix/exe-icons/<sha1>.png', 'from the .exe');
    eq(b.entryIcon({}, argv(BOTTLE, 'Hidden Thing')), null, '.exe missing');
    eq(b.entryIcon({}, argv(BOTTLE, 'Rel')), null, 'relative path');
    eq(b.entryIcon({}, argv(BOTTLE, 'Broken')), null, 'not a program');
    eq(b.entryIcon({}, argv('Some Bottle', 'Not There')), null);
    eq(b.entryIcon({}, argv('Other Bottle', 'Some Game')), null);
    eq(b.entryIcon({}, ['bottles', '-e', 'x.exe', '-b', 'B']), null, 'no program');
    eq(b.entryIcon({}, ['other']), null);
});

test('steam: shortcuts.vdf', () => {
    eq(readShortcuts(`${HOME}/missing.vdf`), []);
    const broken = `${HOME}/broken.vdf`;
    GLib.file_set_contents(broken, '\x00shortcuts\x00\x09');
    eq(readShortcuts(broken), [], 'corrupt');
    const native = `${HOME}/.local/share/Steam`;
    eq(shortcutFiles(native).length, 2, 'one per account, with or without the file');
    eq(readShortcuts(shortcutFiles(native).find(f => f.includes('/111/'))), [
        {id: '2236688360', name: 'Some Game.exe', exe: GAME_EXE, icon: null},
        {id: '5', name: null, exe: null, icon: null},
    ]);
    const other = `${HOME}/other.vdf`;
    GLib.file_set_contents(other, '\x00other\x00\x08\x08');
    eq(readShortcuts(other), [], 'no shortcuts map');
    eq(shortcutLook({name: 'Game.EXE', icon: null, exe: GAME_EXE}, `${HOME}/look`).name, 'Game');
    ok(shortcutLook({name: null, icon: null, exe: GAME_EXE}, `${HOME}/look`).icon.startsWith(`${HOME}/look/`));
    eq(shortcutLook({name: '', icon: `${HOME}/custom-icon.png`, exe: GAME_EXE}), {name: null, icon: `${HOME}/custom-icon.png`});
    eq(shortcutLook({name: 'x', icon: `${HOME}/missing.png`, exe: `${GAME_DIR}/Broken.exe`}), {name: 'x', icon: null});
    eq(shortcutLook({name: 'x', icon: `${HOME}/icon.ico`, exe: null}), {name: 'x', icon: null});
});

test('steam: shortcuts, launch detection, games', () => {
    const st = S('steam');
    const idx = index([
        {id: 'hl.desktop', exec: 'steam steam://rungameid/70'},
        {id: 'old.desktop', exec: 'steam steam://run/80', icon: 'steam_icon_80'},
        {id: 'icon-only.desktop', exec: '/usr/bin/x', icon: 'steam_icon_99'},
        {id: 'nonsteam.desktop', exec: 'steam steam://rungameid/9606503357577428992'},
    ]);
    const map = idx.map('steam');
    eq(['70', '80', '99', '2236688360'].map(k => map.get(k)), ['hl.desktop', 'old.desktop', 'icon-only.desktop', 'nonsteam.desktop']);
    eq(idx.owner.get('icon-only.desktop'), undefined, 'an icon alone doesn\'t make it Steam\'s');

    const hl = `${HOME}/.local/share/Steam/steamapps/common/Half-Life/hl_linux`;
    const game = (env, wmClass = 'steam_app_70', exe = hl) => ctx({wmClass, proc: {pid: 0, argv: [exe], exe, cwd: null, env}});
    eq(st.launched(game({SteamAppId: '70'})), true);
    eq(st.launched(game({SteamAppId: '70', GAMEID: 'umu-70'})), false, 'umu');
    eq(st.launched(game({SteamAppId: 'default'})), false);
    eq(st.identify(game({SteamAppId: '70'}), idx), {id: 'hl.desktop'});
    const outside = game({}, 'hl_linux');
    eq(st.identify(outside, idx), {id: 'hl.desktop'}, 'from its library folder');
    eq(outside.steamIds, ['70']);
    const cs = game({}, 'x', `${HOME}/SteamLib2/steamapps/common/CS/hl_linux`);
    eq(st.identify(cs, index([])), null, 'known game, no entry');
    eq(st.fallback(cs), {iconName: 'steam_icon_80', icon: `${HOME}/.local/share/Steam/appcache/librarycache/80_icon.jpg`, name: 'Counter-Strike "CS"'});
    const withShortcutIcon = game({SteamAppId: '70'});
    st.identify(withShortcutIcon, index([]));
    eq(st.fallback(withShortcutIcon).icon, `${HOME}/.var/app/com.valvesoftware.Steam/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png`);
    const proton = ctx({wmClass: 'steam_app_80', proc: {pid: 0, argv: ['C:\\x.exe'], exe: '/usr/bin/wine', cwd: '/', env: {}}});
    st.identify(proton, index([]));
    eq(st.fallback(proton).icon, null, 'Proton: the .exe has a better icon');
    eq(st.identify(ctx({proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}}), idx), null);
    const unknown = game({SteamAppId: '12345'}, 'steam_app_12345', '/opt/x');
    st.identify(unknown, index([]));
    eq(st.fallback(unknown), {iconName: 'steam_icon_12345', icon: null, name: null}, 'no manifest');
    const nameless = game({}, 'x', `${HOME}/.local/share/Steam/steamapps/common/Nameless/run`);
    eq(st.identify(nameless, index([])), null);
    eq(st.fallback(nameless).name, null, 'a manifest without a name');
    eq(st.fallback(ctx({proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}})), null);
    const nonSteam = game({SteamAppId: '2236688360'}, 'steam_app_2236688360', GAME_EXE);
    st.identify(nonSteam, index([]));
    eq(st.fallback(nonSteam).name, 'Some Game');
    eq(st._gameAt(ctx({launcherSandbox: 'net.lutris.Lutris', proc: {pid: 0, argv: [hl], exe: hl, cwd: null, env: {}}})), null,
        'another launcher\'s game');
});

test('steam: ids from every signal', () => {
    const st = S('steam');
    const ids = env => st._ids(ctx({wmClass: 'steam_app_1', proc: {pid: 0, argv: [], exe: null, cwd: null, env}}));
    eq(ids({SteamAppId: '2', SteamGameId: '3', STEAM_COMPAT_DATA_PATH: '/s/compatdata/4/', WINEPREFIX: '/s/compatdata/5/pfx', GAMEID: 'umu-6'}),
        ['1', '2', '3', '4', '5', '6']);
    eq(ids({SteamAppId: '0', SteamGameId: '1', GAMEID: 'umu-default'}), ['1'], 'zero, duplicates and umu-default');
});

test('steam: entry icons', () => {
    const st = S('steam');
    ok(st.entryIcon({exec: 'steam steam://rungameid/9606503357577428992'}).endsWith('/custom-icon.png') ||
        st.entryIcon({exec: 'steam steam://rungameid/9606503357577428992'}).includes('/exe-icons/'));
    eq(st.entryIcon({exec: `steam steam://rungameid/${(12345n << 32n) | 0x2000000n}`}), null, 'unknown non-Steam game');
    eq(short(st.entryIcon({exec: 'steam steam://rungameid/70'})), '~/.var/app/com.valvesoftware.Steam/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png');
    eq(short(st.entryIcon({exec: 'steam steam://rungameid/80'})), '~/.local/share/Steam/appcache/librarycache/80_icon.jpg');
    eq(st.entryIcon({exec: 'steam steam://rungameid/12345'}), null);
    eq(short(st.entryIcon({exec: 'steam steam://rungameid/71'})), '~/.local/share/icons/hicolor/32x32/apps/steam_icon_71.png');
    eq(short(st.entryIcon({exec: 'steam steam://rungameid/75'})), '~/.local/share/Steam/appcache/librarycache/75/0123456789abcdef0123456789abcdef01234567.jpg');
    eq(st.entryIcon({exec: '/usr/bin/x'}), null);
    eq(st.entryIcon({}), null);
});

test('wine: menu entries and prefixes', () => {
    const w = S('wine');
    const prefix = `${HOME}/.wine-game`;
    const idx = index([
        {id: 'game.desktop', exec: `env WINEPREFIX="${prefix}" wine C:\\\\Game\\\\game.exe`},
        {id: 'lnk.desktop', exec: `env WINEPREFIX=${prefix} wine start /unix ${prefix}/drive_c/users/x/Start\\ Menu/Other\\ Game.lnk`},
        {id: 'default.desktop', exec: 'wine "C:\\\\Program Files\\\\App\\\\app.exe"'},
        {id: 'bare.desktop', exec: 'wine'},
        {id: 'no-wine.desktop', exec: '/usr/bin/x'},
    ]);
    eq(idx.owner.get('game.desktop'), 'wine');
    eq(idx.owner.get('bare.desktop'), undefined);
    const run = (argv, env) => ctx({proc: {pid: 0, argv, exe: '/usr/bin/wine64-preloader', cwd: '/', env}});
    eq(w.identify(run(['C:\\Game\\game.exe'], {WINEPREFIX: prefix}), idx), {id: 'game.desktop'});
    eq(w.identify(run(['C:\\x\\OtherGame.exe'], {WINEPREFIX: prefix}), idx), {id: 'lnk.desktop'}, '.lnk named like the .exe');
    eq(w.identify(run(['C:\\Program Files\\App\\app.exe'], {}), idx), {id: 'default.desktop'}, 'default prefix');
    eq(w.identify(run(['C:\\nope.exe'], {WINEPREFIX: prefix}), idx), null);
    eq(w.identify(ctx({proc: {pid: 0, argv: ['/usr/bin/x'], exe: '/usr/bin/x', cwd: '/', env: {}}}), idx), null, 'not Wine');
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
    eq(p.identify(proc({}), idx), null);
    eq(new AppIndex([{id: 'a_b.desktop', name: 'X'}], sources).map('snap').size, 0, 'no Exec');
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
