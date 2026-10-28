import {GAME_DIR, GAME_EXE, HOME, eq, short, test} from './harness.js';
import {kill, spawnMapper} from './test-process.js';
import {AppIndex} from '../src/lib/appindex.js';
import {guessPaths, matchTitle, matchWindow, windowContext} from '../src/lib/matcher.js';
import {createSources} from '../src/sources/registry.js';

const WGAME = `Z:${GAME_EXE.replace(/\//g, '\\')}`;
const BOTTLE = `${HOME}/.var/app/com.usebottles.bottles/data/bottles/bottles/SomeBottle`;
const NATIVE_BOTTLE = `${HOME}/.local/share/bottles/bottles/SomeBottle`;
const HL = `${HOME}/.local/share/Steam/steamapps/common/Half-Life/hl_linux`;
const LUTRIS_ICON = '~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png';
const EXE_ICON = '~/.cache/icon-fix/exe-icons/<sha1>.png';

const ENTRIES = [
    {id: 'steam_hl.desktop', name: 'Half-Life', exec: 'steam steam://rungameid/70', icon: 'steam_icon_70'},
    {id: 'steam_some.desktop', name: 'Some Game.exe', exec: 'steam steam://rungameid/9606503357577428992', icon: ''},
    {id: 'heroic_some.desktop', name: 'Some Game (Heroic)', exec: 'xdg-open heroic://launch?appName=abc123&runner=sideload', icon: '/x.png'},
    {id: 'net.lutris.some-game-1.desktop', name: 'Some Game', exec: 'env LUTRIS_SKIP_INIT=1 lutris lutris:rungameid/1', icon: 'lutris_some-game'},
    {id: 'bottles_some.desktop', name: 'Some Game', exec: 'flatpak run --command=bottles-cli com.usebottles.bottles run -p "Some Game" -b "Some Bottle"', icon: '/y.png'},
    {id: 'wine-game.desktop', name: 'Wine Game', exec: `env WINEPREFIX=${HOME}/.wine-game wine C:\\\\Game\\\\game.exe`, icon: 'abc_game.0'},
    {id: 'org.example.Foo.desktop', name: 'Foo', exec: '/usr/bin/foo', wmClass: 'FooClass', icon: 'foo'},
    {id: 'org.example.Titled.desktop', name: 'Window Title App', exec: '/opt/titled/run'},
    {id: 'spotify_spotify.desktop', name: 'Spotify', exec: 'env BAMF=1 /snap/bin/spotify', icon: 'spotify'},
    {id: 'native-game.desktop', name: 'Native Thing', exec: `${HOME}/Games/Native/run.sh`},
];

const wine = (env, extra = {}, argv = [WGAME], cwd = GAME_DIR) => ({...extra, proc: {pid: 0, argv, exe: '/usr/bin/wine64-preloader', cwd, env}});
const umu = (prefix, extra = {}) => ({SteamAppId: 'default', GAMEID: 'umu-default', WINEPREFIX: `${prefix}/pfx/`, STEAM_COMPAT_DATA_PATH: prefix, ...extra});

// What a match comes to: the entry, or what each source would show.
function outcome({primary, fallbacks}) {
    return primary ? primary.id : fallbacks.map(f => [f.name ?? null, short(f.icon) ?? null, f.iconName ?? null]);
}

export const CASES = [
    ['steam game by env', {wmClass: 'steam_app_70', proc: {pid: 0, argv: ['./hl_linux'], exe: HL, cwd: null, env: {SteamAppId: '70'}}}],
    ['steam game outside steam', {wmClass: 'hl_linux', proc: {pid: 0, argv: ['./hl_linux'], exe: HL, cwd: null, env: {}}}],
    ['non-steam shortcut', {wmClass: 'steam_app_2236688360', ...wine({SteamAppId: '2236688360'})}],
    ['flatpak steam, non-steam', {wmClass: 'steam_app_2236688360', ...wine({SteamAppId: '2236688360'}, {launcherSandbox: 'com.valvesoftware.Steam'})}],
    ['heroic by env', {wmClass: 'steam_app_default', ...wine({HEROIC_APP_NAME: 'abc123', SteamAppId: 'default', GAMEID: 'umu-default'})}],
    ['heroic by prefix', {wmClass: 'steam_app_default', ...wine(umu(`${HOME}/Games/Heroic/Prefixes/Some Game`))}],
    ['heroic flatpak', {wmClass: 'steam_app_default', ...wine(umu(`${HOME}/Games/Heroic/Prefixes/Flat`), {launcherSandbox: 'com.heroicgameslauncher.hgl'})}],
    ['lutris native', {wmClass: 'steam_app_default', ...wine(umu(`${HOME}/Games/lutris-pfx`, {LUTRIS_GAME_UUID: 'n', GAME_NAME: 'Named In Lutris'}))}],
    ['lutris prefix only', {wmClass: 'some game.exe', ...wine({WINEPREFIX: `${HOME}/Games/lutris-pfx`})}],
    ['lutris flatpak', {wmClass: 'steam_app_default', ...wine(umu(`${HOME}/Games/lutris-flat`, {LUTRIS_GAME_UUID: 'f'}), {launcherSandbox: 'net.lutris.Lutris'})}],
    ['bottles flatpak', {wmClass: 'steam_proton', ...wine({WINEPREFIX: BOTTLE, BOTTLE: 'Some Bottle'}, {launcherSandbox: 'com.usebottles.bottles'})}],
    ['bottles native', {wmClass: 'steam_proton', ...wine({WINEPREFIX: NATIVE_BOTTLE, BOTTLE: 'Some Bottle'})}],
    ['plain wine, menu entry', {wmClass: 'game.exe', ...wine({WINEPREFIX: `${HOME}/.wine-game`}, {}, ['C:\\Game\\game.exe'], `${HOME}/.wine-game/drive_c/Game`)}],
    ['plain wine, game folder', {wmClass: 'some game.exe', ...wine({}, {}, [WGAME], '/tmp')}],
    ['native by class', {wmClass: 'FooClass', proc: {pid: 0, argv: ['/usr/bin/foo'], exe: '/usr/bin/foo', cwd: '/', env: {}}}],
    ['native by gtk id', {gtkId: 'org.example.Foo', proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}}],
    ['native by sandbox id', {sandboxId: 'org.example.Foo', proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}}],
    ['native by instance', {wmClass: 'x', wmInstance: 'foo', proc: {pid: 0, argv: [], exe: null, cwd: null, env: {}}}],
    ['native by exact path', {wmClass: 'x', proc: {pid: 0, argv: [`${HOME}/Games/Native/run.sh`], exe: '/usr/bin/bash', cwd: '/', env: {}}}],
    ['native by folder', {wmClass: 'x', proc: {pid: 0, argv: [`${HOME}/Games/Native/bin/game`], exe: `${HOME}/Games/Native/bin/game`, cwd: '/', env: {}}}],
    ['native by cwd', {wmClass: 'x', proc: {pid: 0, argv: ['./game'], exe: '/usr/bin/python3', cwd: `${HOME}/Games/Native/data`, env: {}}}],
    ['snap', {wmClass: 'spotify', proc: {pid: 0, argv: ['/snap/spotify/1/spotify'], exe: '/snap/spotify/1/spotify', cwd: '/', env: {SNAP_NAME: 'spotify'}}}],
    ['flatpak app argv', {wmClass: 'x', proc: {pid: 0, argv: ['flatpak', 'run', 'org.example.Foo'], exe: null, cwd: null, env: {}}}],
    ['nothing known', {wmClass: 'nothing', proc: {pid: 0, argv: ['/opt/x/x'], exe: '/opt/x/x', cwd: '/', env: {}}}],
    ['no process', {wmClass: 'nothing'}],
    ['wine without argv', {wmClass: 'x', proc: {pid: 0, argv: [], exe: '/usr/bin/wine64-preloader', cwd: '/', env: {}}}],
    ['heroic game in a plain entry\'s folder', wine({HEROIC_APP_NAME: 'nothere'}, {}, ['C:\\x.exe'], `${HOME}/Games/Native/data`)],
    ['wine, other prefix', {wmClass: 'x', ...wine({WINEPREFIX: `${HOME}/.wine-elsewhere`}, {}, ['C:\\Game\\game.exe'], '/')}],
];

test('matcher: windows with every launcher, with and without entries', () => {
    const expected = {
        'entries': {
            'steam game by env': 'steam_hl.desktop',
            'steam game outside steam': 'steam_hl.desktop',
            'non-steam shortcut': 'steam_some.desktop',
            'flatpak steam, non-steam': 'steam_some.desktop',
            'heroic by env': 'heroic_some.desktop',
            'heroic by prefix': 'heroic_some.desktop',
            'heroic flatpak': [["Some Game (Heroic Flatpak)",null,null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'lutris native': 'net.lutris.some-game-1.desktop',
            'lutris prefix only': 'net.lutris.some-game-1.desktop',
            'lutris flatpak': 'net.lutris.some-game-1.desktop',
            'bottles flatpak': 'bottles_some.desktop',
            'bottles native': 'bottles_some.desktop',
            'plain wine, menu entry': 'wine-game.desktop',
            'plain wine, game folder': 'heroic_some.desktop',
            'native by class': 'org.example.Foo.desktop',
            'native by gtk id': 'org.example.Foo.desktop',
            'native by sandbox id': 'org.example.Foo.desktop',
            'native by instance': 'org.example.Foo.desktop',
            'native by exact path': 'native-game.desktop',
            'native by folder': 'native-game.desktop',
            'native by cwd': 'native-game.desktop',
            'snap': 'spotify_spotify.desktop',
            'flatpak app argv': 'org.example.Foo.desktop',
            'nothing known': [],
            'no process': [],
            'wine, other prefix': 'wine-game.desktop',
            'heroic game in a plain entry\'s folder': 'native-game.desktop',
        },
        'no entries': {
            'steam game by env': [["Half-Life","~/.var/app/com.valvesoftware.Steam/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png","steam_icon_70"]],
            'steam game outside steam': [["Half-Life","~/.var/app/com.valvesoftware.Steam/.local/share/icons/hicolor/32x32/apps/steam_icon_70.png","steam_icon_70"]],
            'non-steam shortcut': [["Some Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'flatpak steam, non-steam': [["Some Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'heroic by env': [["Some Game (Heroic)",null,null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'heroic by prefix': [["Some Game (Heroic)",null,null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'heroic flatpak': [["Some Game (Heroic Flatpak)",null,null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'lutris native': [["Named In Lutris","~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png","lutris_some-game"],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'lutris prefix only': [[null,"~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png","lutris_some-game"],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'lutris flatpak': [[null,"~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png","lutris_some-game"],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'bottles flatpak': [["Some Game","~/.var/app/com.usebottles.bottles/data/bottles/bottles/SomeBottle/icons/Some Game.png",null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'bottles native': [["Some Game","~/.local/share/bottles/bottles/SomeBottle/icons/Some Game.png",null],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'plain wine, menu entry': [["game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
            'plain wine, game folder': [["Some Game (Heroic)",null,null],[null,"~/.var/app/net.lutris.Lutris/data/icons/hicolor/128x128/apps/lutris_some-game.png","lutris_some-game"],["Png Game","~/.cache/icon-fix/exe-icons/<sha1>.png",null]],
        },
    };
    for (const [label, entries] of [['entries', ENTRIES], ['no entries', []]]) {
        const sources = createSources();
        const index = new AppIndex(entries, sources);
        for (const [name, hints] of CASES)
            eq(outcome(matchWindow(index, sources, hints)), expected[label][name] ?? [], `${label}: ${name}`);
    }
});

test('matcher: the .exe a process has mapped, whatever its drive letter', () => {
    const pid = spawnMapper(['python3', '-c', 'import mmap,sys,time; f=open(sys.argv[1],"rb"); m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ); time.sleep(30)', GAME_EXE]);
    try {
        const hints = {wmClass: 'steam_app_default', proc: {pid, argv: ['S:\\Games\\Some Game.exe'], exe: '/usr/bin/wine64-preloader', cwd: '/', env: {}}};
        eq(windowContext(hints).paths, [GAME_EXE]);
        const sources = createSources();
        eq(outcome(matchWindow(new AppIndex([], sources), sources, hints)),
            [['Some Game (Heroic)', null, null], [null, LUTRIS_ICON, 'lutris_some-game'], ['Png Game', EXE_ICON, null]]);
    } finally {
        kill(pid);
    }
});

test('matcher: titles and folder guesses', () => {
    const index = new AppIndex(ENTRIES, createSources());
    eq(matchTitle(index, 'Window Title App'), {id: 'org.example.Titled.desktop'});
    eq(matchTitle(index, 'Something else'), null);
    eq(matchTitle(index, null), null);
    const ctx = windowContext({proc: {pid: 0, argv: ['/a/b'], exe: '/a/b', cwd: '/c', env: {}}});
    eq(guessPaths(ctx, {name: 'x'}), ['/a/b', '/c']);
    ctx.launcher = 'y';
    eq(guessPaths(ctx, {name: 'x'}), []);
    eq(guessPaths(ctx, {name: 'y'}), ['/a/b', '/c']);
});
