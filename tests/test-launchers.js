import GLib from 'gi://GLib';

import {GAME_DIR, GAME_EXE, HOME, eq, ok, short, test} from './harness.js';
import {AppIndex, tryCall} from '../src/lib/appindex.js';
import {windowContext} from '../src/lib/matcher.js';
import {GENERIC_BINARIES} from '../src/lib/process.js';
import {LAUNCHERS, bottlePrograms, heroicGames, lutrisGame} from '../src/launchers.js';
import {LauncherSource, asLists, fillTemplate, fit, flavorOfPath, iconShaped, parseOptions} from '../src/sources/launcher.js';
import {createSources} from '../src/sources/registry.js';

const sources = createSources();
const S = name => sources.find(s => s.name === name);
const BOTTLE = `${HOME}/.var/app/com.usebottles.bottles/data/bottles/bottles/SomeBottle`;
const NATIVE_BOTTLE = `${HOME}/.local/share/bottles/bottles/SomeBottle`;
const WGAME = `Z:${GAME_EXE.replace(/\//g, '\\')}`;
const EXE_ICON = '~/.cache/icon-fix/exe-icons/<sha1>.png';
const FLAT_LUTRIS_ICON = '~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png';

// A window context as matchWindow() builds it.
function ctx(hints) {
    const c = windowContext(hints);
    c.launcher = sources.find(s => (s.sandbox && s.sandbox === c.launcherSandbox) || tryCall(s, 'launched', c))?.name ?? null;
    return c;
}
const wine = (env = {}, extra = {}) => ctx({proc: {pid: 0, argv: [WGAME], exe: '/usr/bin/wine64-preloader', cwd: GAME_DIR, env}, ...extra});
const nothing = () => ctx({proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}});
const index = entries => new AppIndex(entries, sources);
const fieldsOf = (idx, name) => Object.fromEntries([...idx.map(name)].map(([id, s]) => [id, s.fields]));

test('launchers: described as data, one engine for all', () => {
    eq(LAUNCHERS.map(d => d.name), ['heroic', 'steam', 'bottles', 'lutris']);
    ok(LAUNCHERS.every(d => d.library.length && d.shortcut && d.sandbox), 'each says where its games are and how it names them');
    ok(sources.filter(s => s instanceof LauncherSource).length === 4);
    ok(['steam', 'lutris', 'bottles-cli', 'heroic', 'reaper'].every(b => GENERIC_BINARIES.has(b)), 'their programs say nothing');
    eq(S('lutris').envKeys, ['STEAM_COMPAT_DATA_PATH', 'LUTRIS_GAME_UUID', 'GAME_NAME']);
});

test('launchers: the engine\'s pieces', () => {
    eq(fillTemplate('steam_icon_{id}', {id: ['70', '71']}), 'steam_icon_70');
    eq(fillTemplate('steam_icon_{id}', {id: '70'}), 'steam_icon_70');
    eq(fillTemplate('steam_icon_{id}', {}), null);
    eq(fillTemplate(null, {}), null);
    eq(parseOptions(['x', 'bottles-cli', 'run', '-p', 'P', '--bottle=B', '--', '-p', 'Z'], {commands: ['bottles-cli'], flags: {'-p': 'p', '--bottle': 'b'}}),
        {p: 'P', b: 'B'});
    eq(parseOptions(['/usr/bin/bottles-cli', '--other=1'], {commands: ['bottles-cli'], flags: {}}), {});
    eq(parseOptions(['x'], {commands: ['y'], flags: {}}), null);
    eq([...asLists({a: 'x', b: ['y', 'z'], c: null, d: '', e: [5]})], [['a', ['x']], ['b', ['y', 'z']]]);
    const known = new Map([['id', ['1', '2']], ['exe', ['g']]]);
    eq(fit({id: '2', exe: 'g'}, known), 1);
    eq(fit({id: '3'}, known), -1);
    eq(fit({other: 'x'}, known), -1);
    eq(fit({}, known), -1, 'saying nothing fits nothing');
    eq(flavorOfPath(`${HOME}/.var/app/Org.X.Y/config/a.json`), 'org.x.y');
    eq(flavorOfPath(`${HOME}/.config/a.json`), 'native');
    eq(iconShaped(`${HOME}/.config/heroic/icons/1207.png`), false, 'a cover');
    eq(iconShaped(`${HOME}/custom-icon.png`), true);
    eq(iconShaped(`${HOME}/missing.png`), false);
});

test('heroic: installed games of every store', () => {
    const at = `${HOME}/.config/heroic/x/installed.json`;
    eq(heroicGames(null, at), []);
    eq(heroicGames([null], at), [null]);
    eq(heroicGames([{id: 'a', path: GAME_DIR}], at)[0].fields, {appName: 'a'}, 'nile');
    eq(heroicGames({installed: [{appName: 7, install_path: GAME_DIR}]}, at)[0].fields.appName, '7', 'gog');
    const sideload = heroicGames({games: [{app_name: 's', title: 'T', install: {executable: GAME_EXE}}]}, at)[0];
    eq([sideload.name, sideload.exe, sideload.dir], ['T', GAME_EXE, null]);
    eq(heroicGames({x: {app_name: 'x', install_path: GAME_DIR, executable: 'Some Game.exe'}}, at)[0].exe, GAME_EXE, 'legendary');
    eq(heroicGames({x: {app_name: 'x', install: {executable: 5}}}, at), [null], 'nowhere');
    eq(short(heroicGames([{id: 'epicgame', path: GAME_DIR}], `${HOME}/.config/heroic/x/y.json`)[0].icon),
        '~/.config/heroic/icons/epicgame.jpg', 'the icon it saved');

    const h = S('heroic');
    const records = h.records();
    eq(records.find(r => r.fields.appName[0] === 'abc123').prefix, `${HOME}/Games/Heroic/Prefixes/Some Game`.toLowerCase(),
        'merged with its GamesConfig');
    eq(records.find(r => r.fields.appName[0] === 'nofolder').dir, null, 'a program in a shared folder: no folder of its own');
    eq(h.records('com.heroicgameslauncher.hgl')[0].flavor, 'com.heroicgameslauncher.hgl', 'the Flatpak\'s first');
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
    eq(fieldsOf(idx, 'heroic'), {
        'h1.desktop': {appName: 'epicgame'}, 'h2.desktop': {appName: 'abc123'},
        'h3.desktop': {appName: 'Some Name'}, 'h4.desktop': {appName: '%E0%A4%A'},
    });
    eq(idx.owner.get('h1.desktop'), 'heroic');
    eq(idx.owner.get('other.desktop'), undefined);

    const byEnv = wine({HEROIC_APP_NAME: 'abc123'});
    eq(h.launched(byEnv), true);
    eq(h.identify(byEnv, idx), {id: 'h2.desktop'});
    eq(short(h.fallback(byEnv).icon), EXE_ICON);
    eq(h.fallback(byEnv).name, 'Some Game (Heroic)');
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
    const at = cwd => ctx({proc: {pid: 0, argv: ['C:\\x.exe'], exe: '/usr/bin/wine', cwd, env: {WINEPREFIX: shared}}});
    eq(h.game(at(`${HOME}/Games/GOG/Gog Game`)).fields.appName, ['1207']);
    eq(short(h.fallback(at(`${HOME}/Games/Epic/Epic Game`)).icon), '~/.config/heroic/icons/epicgame.jpg');
    eq(h.game(at('/')), null, 'shared, no folder');
    // Heroic's Flatpak config folder gone: its prefixes simply aren't known.
    const flatConfigs = `${HOME}/.var/app/com.heroicgameslauncher.hgl/config/heroic/GamesConfig`;
    GLib.rename(flatConfigs, `${flatConfigs}.off`);
    eq(h.launched(wine({WINEPREFIX: `${HOME}/Games/Heroic/Prefixes/Flat`})), false);
    GLib.rename(`${flatConfigs}.off`, flatConfigs);
    eq(h.launched(wine({WINEPREFIX: `${HOME}/Games/Heroic/Prefixes/Flat`})), true);
    // Its files listed but unreadable (as if removed meanwhile): skipped.
    GLib.chmod(flatConfigs, 0o644);
    eq(h.launched(wine({WINEPREFIX: `${HOME}/Games/Heroic/Prefixes/Flat`})), false);
    GLib.chmod(flatConfigs, 0o755);

    // No signal but the folder (no launcher known): a guess.
    const byFolder = wine({});
    eq(h.launched(byFolder), false);
    eq(h.game(byFolder).fields.appName, ['abc123']);
    eq(h.game(byFolder), h.game(byFolder), 'kept on the context');
    // Another launcher's game: no folder guess.
    eq(h.game(wine({}, {launcherSandbox: 'net.lutris.Lutris'})), null);
    eq(h.game(nothing()), null, 'nothing to go on');
    eq(h.fallback(nothing()), null);
});

test('heroic: entry icons', () => {
    const h = S('heroic');
    const icon = exec => short(h.entryIcon({exec}, []));
    eq(icon('xdg-open heroic://launch/legendary/epicgame'), '~/.config/heroic/icons/epicgame.jpg');
    eq(icon('xdg-open heroic://launch/abc123'), EXE_ICON, 'from the .exe');
    eq(icon('xdg-open heroic://launch/nofolder'), null, 'not a game it has');
    eq(icon('xdg-open "heroic://launch?appName=abc123&runner=sideload"'), EXE_ICON);
    eq(icon('xdg-open heroic://launch/1207'), '~/.config/heroic/icons/1207.png', 'a cover, no .exe known');
    eq(icon('xdg-open heroic://launch/brokenexe'), null, 'not a program');
    eq(icon('xdg-open heroic://launch/unknown'), null);
    eq(icon('/usr/bin/other'), null);
    eq(h.entryIcon({}, []), null);
});

test('lutris: configs, shortcuts, games', () => {
    const l = S('lutris');
    eq(lutrisGame({game: {exe: GAME_EXE, prefix: `${HOME}/p/`}}, '/x/some-game-17.yml'),
        {fields: {slug: 'some-game'}, prefix: `${HOME}/p`, exe: GAME_EXE, dir: null});
    eq(lutrisGame({game: {working_dir: GAME_DIR}}, '/x/a-1.yaml').dir, GAME_DIR);
    eq(lutrisGame(null, '/x/a.yml'), {fields: {slug: 'a'}, prefix: null, exe: null, dir: null});

    const idx = index([
        {id: 'net.lutris.some-game-1.desktop', exec: 'env LUTRIS_SKIP_INIT=1 lutris lutris:rungameid/1'},
        {id: 'x.desktop', exec: 'lutris lutris:rungame/other-game'},
        {id: 'y.desktop', exec: 'lutris lutris:rungameid/9', icon: 'lutris_plain-game'},
        {id: 'z.desktop', exec: 'lutris lutris:rungameid/10'},
        {id: 'z2.desktop', exec: 'lutris lutris:rungameid/11', icon: 'not-lutris'},
        {id: 'w.desktop', exec: '/usr/bin/other'},
    ]);
    eq(fieldsOf(idx, 'lutris'), {
        'net.lutris.some-game-1.desktop': {slug: 'some-game'}, 'x.desktop': {slug: 'other-game'}, 'y.desktop': {slug: 'plain-game'},
    });
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
    eq(l.identify(nothing(), idx), null);
    eq(l.fallback(nothing()), null);
    eq(l.game(wine({}, {launcherSandbox: 'com.heroicgameslauncher.hgl'})), null, 'another launcher\'s game');
    // umu runs the game in <prefix>/pfx; the Flatpak's window, its own config.
    const umu = {WINEPREFIX: `${HOME}/Games/lutris-flat/pfx/`, STEAM_COMPAT_DATA_PATH: `${HOME}/Games/lutris-flat`};
    eq(l.launched(wine(umu)), true, 'a prefix as umu has it');
    eq(l.game(wine(umu, {launcherSandbox: 'net.lutris.Lutris'})).prefix, `${HOME}/Games/lutris-flat`.toLowerCase());
    eq(l.game(wine({}, {launcherSandbox: 'net.lutris.Lutris'})).prefix, `${HOME}/Games/lutris-flat`.toLowerCase(), 'by folder, the Flatpak\'s first');
    eq(l.game(wine({})).prefix, `${HOME}/Games/lutris-pfx`.toLowerCase(), 'by folder, the native one first');
});

test('lutris: entry icons', () => {
    const l = S('lutris');
    const icon = (id, exec) => short(l.entryIcon({id, exec}, []));
    eq(icon('x.desktop', 'lutris lutris:rungame/other-game'), '~/.local/share/icons/hicolor/128x128/apps/lutris_other-game.png');
    eq(icon('net.lutris.some-game-3.desktop', 'lutris lutris:rungameid/3'), FLAT_LUTRIS_ICON);
    eq(icon('x.desktop', 'lutris lutris:rungame/plain-game'), EXE_ICON);
    eq(icon('x.desktop', 'lutris lutris:rungame/unknown'), null);
    eq(icon('x.desktop', 'lutris lutris:rungame/gone-game'), null, '.exe gone');
    eq(icon('x.desktop', 'lutris lutris:rungame/broken-game'), null, 'not a program');
    eq(icon('x.desktop', 'lutris lutris:rungameid/3'), null, 'no slug');
    eq(icon('x.desktop', '/usr/bin/x'), null);
});

test('bottles: launch lines and configs', () => {
    const b = S('bottles');
    const fields = argv => b.shortcutFields({}, argv);
    eq(fields(['bottles-cli', 'run', '-p', 'P', '-b', 'B', '--', '-p', 'X']), {bottle: 'B', program: 'P'});
    eq(fields(['flatpak', 'run', '--command=bottles-cli', 'com.usebottles.bottles', 'run', '--program=P', '--bottle=/b/./B']),
        {bottle: '/b/B', program: 'P'}, 'a path made canonical');
    eq(fields(['/usr/bin/bottles', '-e', 'C:\\G.exe', '-b', 'B', '--other']), {bottle: 'B', exe: 'g'});
    eq(fields(['bottles-cli', 'run', '-p', 'P']), null, 'no bottle');
    eq(fields(['foo', '-b', 'B']), null);
    eq(bottlePrograms({}, '/b/x/bottle.yml').map(r => r.fields), [{bottle: ['/b/x', 'x']}]);
    const [, a, b2] = bottlePrograms({Name: 'N', External_Programs: {
        a: {name: 'A', executable: 'A.exe', path: '/g/A.exe', removed: 'true'}, b: {name: 'B', path: 'rel/B.exe'}, c: {name: 'C'}, d: null,
    }}, '/b/x/bottle.yml');
    eq([a.name, a.fields.bottle, a.stems, a.exe, a.hidden], ['A', ['/b/x', 'x', 'N'], ['a'], '/g/A.exe', true]);
    eq([b2.name, b2.exe, b2.hidden], ['B', null, false]);
    // A shortcut: by the program it starts and by its own name.
    const lnk = `${HOME}/.wine-game/drive_c/users/x/Start Menu/Launcher.lnk`;
    eq(bottlePrograms({External_Programs: {a: {name: 'L', executable: 'Launcher.lnk', path: lnk}}}, '/b/x/bottle.yml')[1].stems,
        ['launcher', 'game']);
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
    // Its program "Via Shortcut" is a .lnk to Other.exe.
    eq(b.fallback(other).name, 'Via Shortcut', 'a program given as a shortcut');
    const unknown = ctx({proc: {pid: 0, argv: ['C:\\nope.exe'], exe: '/usr/bin/wine', cwd: '/', env: {WINEPREFIX: BOTTLE, BOTTLE: 'Some Bottle'}}});
    eq(b.identify(unknown, idx), null);
    eq(b.game(unknown).fields.program, undefined, 'the bottle itself');
    eq(b.launched(wine({BOTTLE: 'x'})), true);
    eq(b.launched(wine({})), false);
    // Nothing but the folder of one of its programs: a guess.
    eq(b.identify(wine({}), idx), {id: 'by-name.desktop'});
    eq(b.identify(nothing(), idx), null);
    eq(b.fallback(nothing()), null);
});

test('bottles: a native game gets the native shortcut, even by a later key', () => {
    const b = S('bottles');
    // By the bottle's folder name: only the Flatpak's; by its Name: the
    // native one's.
    const idx = index([
        {id: 'flat.desktop', exec: 'flatpak run --command=bottles-cli com.usebottles.bottles run -p "Some Game" -b SomeBottle'},
        {id: 'native.desktop', exec: 'bottles-cli run -p "Some Game" -b "Some Bottle"'},
    ]);
    eq(b.identify(wine({WINEPREFIX: NATIVE_BOTTLE}), idx), {id: 'native.desktop'});
    eq(b.identify(wine({WINEPREFIX: BOTTLE}, {launcherSandbox: 'com.usebottles.bottles'}), idx), {id: 'flat.desktop'});
    // Only the other flavor's: taken.
    const flatOnly = index([{id: 'flat.desktop', exec: 'flatpak run --command=bottles-cli com.usebottles.bottles run -p "Some Game" -b SomeBottle'}]);
    eq(b.identify(wine({WINEPREFIX: NATIVE_BOTTLE}), flatOnly), {id: 'flat.desktop'});
});

test('bottles: entry icons', () => {
    const b = S('bottles');
    const argv = (bottle, program, flatpak = true) => [...flatpak ? ['flatpak', 'run', '--command=bottles-cli', 'com.usebottles.bottles'] : ['bottles-cli'], 'run', '-p', program, '-b', bottle];
    const icon = args => b.entryIcon({}, args);
    eq(icon(argv('Some Bottle', 'Some Game')), `${BOTTLE}/icons/Some Game.png`, 'Flatpak entry: Flatpak bottle');
    eq(icon(argv('Some Bottle', 'Some Game', false)), `${NATIVE_BOTTLE}/icons/Some Game.png`, 'native entry: native bottle');
    eq(icon(argv('SomeBottle', 'Some Game')), `${BOTTLE}/icons/Some Game.png`, 'by folder name');
    eq(icon(argv(BOTTLE, 'Some Game')), `${BOTTLE}/icons/Some Game.png`, 'by path');
    eq(short(icon(argv(BOTTLE, 'Tool "Pro" & Co'))), EXE_ICON, 'from the .exe');
    eq(icon(argv(BOTTLE, 'Hidden Thing')), null, '.exe missing');
    eq(icon(argv(BOTTLE, 'Rel')), null, 'relative path');
    eq(icon(argv(BOTTLE, 'Broken')), null, 'not a program');
    eq(icon(argv('Some Bottle', 'Not There')), null);
    eq(icon(argv('Other Bottle', 'Some Game')), null);
    eq(icon(['other']), null);
});

test('steam: non-Steam games, from shortcuts.vdf', () => {
    const st = S('steam');
    const shortcuts = st.records().filter(r => !r.dir || r.exe);
    const some = shortcuts.find(r => r.fields.id[0] === '2236688360');
    eq([some.name, some.exe, some.icon], ['Some Game', GAME_EXE, null], '"Some Game.exe" as Steam names it');
    ok(shortcuts.some(r => r.fields.id[0] === '5' && r.name === null), 'unnamed');
    // A corrupt file reads as nothing.
    const user = `${HOME}/.local/share/Steam/userdata/999/config`;
    GLib.mkdir_with_parents(user, 0o755);
    GLib.file_set_contents(`${user}/shortcuts.vdf`, '\x00shortcuts\x00\x09');
    eq(st.records().filter(r => r.fields.id[0] === '2236688360').length, 2, 'the others still read');
    GLib.unlink(`${user}/shortcuts.vdf`);
    GLib.file_set_contents(`${user}/shortcuts.vdf`, '\x00other\x00\x08\x08');
    ok(st.records().length > 0, 'no shortcuts map');
    GLib.unlink(`${user}/shortcuts.vdf`);
});

test('steam: shortcuts, launch detection, games', () => {
    const st = S('steam');
    const idx = index([
        {id: 'hl.desktop', exec: 'steam steam://rungameid/70'},
        {id: 'old.desktop', exec: 'steam steam://run/80', icon: 'steam_icon_80'},
        {id: 'icon-only.desktop', exec: '/usr/bin/x', icon: 'steam_icon_99'},
        {id: 'nonsteam.desktop', exec: 'steam steam://rungameid/9606503357577428992'},
    ]);
    eq(fieldsOf(idx, 'steam'), {
        'hl.desktop': {id: '70'}, 'old.desktop': {id: '80'}, 'icon-only.desktop': {id: '99'}, 'nonsteam.desktop': {id: '2236688360'},
    });
    eq(idx.owner.get('icon-only.desktop'), undefined, 'an icon alone doesn\'t make it Steam\'s');

    const hl = `${HOME}/.local/share/Steam/steamapps/common/Half-Life/hl_linux`;
    const game = (env, wmClass = 'steam_app_70', exe = hl) => ctx({wmClass, proc: {pid: 0, argv: [exe], exe, cwd: null, env}});
    eq(st.launched(game({SteamAppId: '70'})), true);
    eq(st.launched(game({SteamAppId: '70', GAMEID: 'umu-70'})), false, 'umu');
    eq(st.launched(game({SteamAppId: 'default'})), false);
    eq(st.identify(game({SteamAppId: '70'}), idx), {id: 'hl.desktop'});
    eq(st.identify(game({}, 'hl_linux'), idx), {id: 'hl.desktop'}, 'from its library folder');
    eq(st.identify(game({}, 'steam_app_99', '/opt/x'), idx), {id: 'icon-only.desktop'}, 'by its icon');
    const cs = game({}, 'x', `${HOME}/SteamLib2/steamapps/common/CS/hl_linux`);
    eq(st.identify(cs, index([])), null, 'known game, no entry');
    eq(st.fallback(cs), {iconName: 'steam_icon_80', icon: `${HOME}/.local/share/Steam/appcache/librarycache/80_icon.jpg`, name: 'Counter-Strike "CS"'});
    eq(st.fallback(game({SteamAppId: '70'})).icon, `${HOME}/.var/app/com.valvesoftware.Steam/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png`);
    const proton = ctx({wmClass: 'steam_app_80', proc: {pid: 0, argv: ['C:\\x.exe'], exe: '/usr/bin/wine', cwd: '/', env: {}}});
    eq(st.fallback(proton).icon, null, 'Proton: the .exe has a better icon');
    eq(st.identify(nothing(), idx), null);
    eq(st.fallback(game({SteamAppId: '12345'}, 'steam_app_12345', '/opt/x')), {iconName: 'steam_icon_12345', icon: null, name: null}, 'no manifest');
    eq(st.fallback(game({}, 'x', `${HOME}/.local/share/Steam/steamapps/common/Nameless/run`)).name, null, 'a manifest without a name');
    eq(st.fallback(nothing()), null);
    eq(st.fallback(game({SteamAppId: '2236688360'}, 'steam_app_2236688360', GAME_EXE)).name, 'Some Game');
    eq(st.game(ctx({launcherSandbox: 'net.lutris.Lutris', proc: {pid: 0, argv: [hl], exe: hl, cwd: null, env: {}}})), null,
        'another launcher\'s game');
});

test('steam: ids from every signal', () => {
    const st = S('steam');
    const ids = env => st.signals(ctx({wmClass: 'steam_app_1', proc: {pid: 0, argv: [], exe: null, cwd: null, env}})).map(([, v]) => v);
    eq(ids({SteamAppId: '2', SteamGameId: '3', STEAM_COMPAT_DATA_PATH: '/s/compatdata/4/', WINEPREFIX: '/s/compatdata/5/pfx', GAMEID: 'umu-6'}),
        ['1', '2', '3', '4', '5', '6']);
    eq(ids({SteamAppId: '0', SteamGameId: '1', GAMEID: 'umu-default'}), ['1', '1'], 'zero and umu-default say nothing');
});

test('steam: entry icons', () => {
    const st = S('steam');
    const icon = exec => short(st.entryIcon({exec}, []));
    ok(['~/custom-icon.png', EXE_ICON].includes(icon('steam steam://rungameid/9606503357577428992')));
    eq(icon(`steam steam://rungameid/${(12345n << 32n) | 0x2000000n}`), null, 'unknown non-Steam game');
    eq(icon('steam steam://rungameid/70'), '~/.var/app/com.valvesoftware.Steam/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png');
    eq(icon('steam steam://rungameid/80'), '~/.local/share/Steam/appcache/librarycache/80_icon.jpg');
    eq(icon('steam steam://rungameid/12345'), null);
    eq(icon('steam steam://rungameid/71'), '~/.local/share/icons/hicolor/32x32/apps/steam_icon_71.png');
    eq(icon('steam steam://rungameid/75'), '~/.local/share/Steam/appcache/librarycache/75/0123456789abcdef0123456789abcdef01234567.jpg');
    eq(icon('/usr/bin/x'), null);
    eq(st.entryIcon({}, []), null);
});

test('launchers: a launcher described with the least there is', () => {
    const dir = `${HOME}/minimal`;
    GLib.mkdir_with_parents(dir, 0o755);
    GLib.file_set_contents(`${dir}/games.json`, JSON.stringify([
        {key: 'a', exe: GAME_EXE, extra: 'one'},
        {key: 'a', extra: 'two', more: 'x'},
        {},
    ]));
    GLib.file_set_contents(`${dir}/locked.yml`, 'x: 1\n');
    GLib.chmod(`${dir}/locked.yml`, 0);
    const minimal = new LauncherSource({
        name: 'minimal',
        shortcut: {exec: /minimal:(?<key>\w+)/},
        window: [{env: 'MINIMAL', field: 'key'}],
        iconName: 'minimal_{key}',
        key: 'key',
        library: [
            {files: () => [`${dir}/games.json`], format: 'json', records: list => list.map(g => g.key
                ? {fields: {key: g.key, ...g.more ? {more: g.more} : {}, exe: g.extra}, exe: g.exe ?? null}
                : {name: 'no fields'})},
            {dirs: () => [dir], match: /\.yml$/, format: 'yaml', records: doc => ({fields: {key: 'y'}, name: String(Object.keys(doc).length)})},
        ],
    });
    eq([minimal.sandbox, minimal.envKeys], [null, ['STEAM_COMPAT_DATA_PATH', 'MINIMAL']]);
    eq(minimal.game(wine({MINIMAL: 'a'})).fields.key, ['a'], 'named, among records without that field');
    const records = minimal.records();
    const a = records.find(r => r.fields.key?.[0] === 'a');
    eq([a.fields.exe, a.fields.more], [['one', 'some game', 'two'], ['x']], 'merged, their programs\' names too');
    eq(records.find(r => r.name === 'no fields').fields, {});
    eq(records.find(r => r.fields.key?.[0] === 'y').name, '0', 'an unreadable file reads empty');
    GLib.chmod(`${dir}/locked.yml`, 0o644);
    eq(fillTemplate('{a}-{b}', {}), null, 'two missing');
    const game = wine({});
    eq([minimal.launched(game), minimal.signals(game), minimal.game(game).fields.key], [false, [], ['a']], 'by folder');
    eq(minimal.iconOf(null, {key: 'a'}), null, 'no icon of its own, none named, none kept anywhere');
    // Two records in one prefix, neither inside the other: none.
    eq(minimal._pick(ctx({proc: {pid: 0, argv: [], exe: null, cwd: '/', env: {}}}),
        [{fields: {key: ['p']}, stems: []}, {fields: {key: ['q']}, stems: []}]), null);
    const idx = new AppIndex([{id: 'm.desktop', exec: 'tool minimal:a'}], [minimal]);
    eq(minimal.identify(game, idx), {id: 'm.desktop'});
});
