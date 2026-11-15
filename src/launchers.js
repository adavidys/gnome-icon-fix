// The game launchers Icon Fix knows, as data: the only place they are
// named. How each is used is the same for all (sources/launcher.js); to
// support another one, describe it here.
//
//   name       its name, for the Debug tab and the logs
//   sandbox    its Flatpak app id: windows from that sandbox were started by it
//   shortcut   how its shortcuts name a game, as fields:
//                exec: regexes over Exec= (named groups are fields), or
//                options: {commands, flags} for `cmd -p X -b Y` lines;
//                also: [{from: 'id' | 'icon', re}] more fields of its shortcuts;
//                hint: [{from, re}] fields of other entries that still name
//                  one of its games (its icon), without being its shortcuts;
//                normalize(fields): fields as its games know them, or null
//   window     what a running game says about itself, strongest first:
//                [{env | class: true | prefix: true, re (named groups) | field}]
//   launchedBy environment variables only it sets: [{env, re?, unless?}]
//   nameEnv    a variable with the game's display name
//   iconName   the icon its shortcuts use, from fields ("steam_icon_{id}")
//   extraIcon(fields)  a small icon it keeps for any game, or null
//   key        the field naming a game in every file (records merged by it)
//   library    where it lists its games: [{files() | dirs() + match, format,
//                records(doc, path)}]; format: json, yaml, vdf, binvdf.
//                A record: {fields, name, dir, prefix, exe, stems, icon}
//   binaries   its programs, which say nothing about the game they run
//   sharedDirs names of its library folders, which hold many games
//   mirror     a shortcut mirror for its Flatpak (mirror/launcher.js)

import GLib from 'gi://GLib';

import {parseVdf} from './lib/formats.js';
import {programOf} from './lib/lnk.js';
import {GENERIC_BINARIES} from './lib/process.js';
import {
    SHARED_DIR_NAMES, StampCache, basename, canonical, configDir, dataDir, exeStem, exists, home, listDir, readText, sandboxDir,
} from './lib/util.js';

// A launcher's folders, the host's and those inside its Flatpak.
const both = (sandbox, native, flatpak) => [...native, ...flatpak.map(parts => sandboxDir(sandbox, ...parts))];

function firstExisting(paths) {
    return paths.find(exists) ?? null;
}

// --- Steam

const STEAM = 'com.valvesoftware.Steam';

function resolveLink(path) {
    try {
        const target = GLib.file_read_link(path);
        return canonical(target.startsWith('/') ? target : `${path}/../${target}`);
    } catch {
        return canonical(path);
    }
}

// Its roots, each once: ~/.steam/steam is usually a link to another one,
// the root itself on Debian's package.
function steamRoots() {
    return [...new Set([
        dataDir('Steam'),
        home('.steam', 'steam'),
        sandboxDir(STEAM, '.local', 'share', 'Steam'),
        home('snap', 'steam', 'common', '.local', 'share', 'Steam'),
    ].map(resolveLink).filter(Boolean))];
}

// libraryfolders.vdf -> the library folders it lists: "1" "/path" (old),
// "0" { "path" "/path" } (current)
const libraryFolders = new StampCache(path => Object.values(parseVdf(readText(path) ?? '').libraryfolders ?? {})
    .map(f => canonical(typeof f === 'string' ? f : f.path)).filter(Boolean));

function steamLibraries() {
    return [...new Set(steamRoots().flatMap(root =>
        [...libraryFolders.get(`${root}/steamapps/libraryfolders.vdf`) ?? [], root]))];
}

// A non-Steam game's shortcut runs a 64-bit game id whose upper half is
// the app id its window is classed with.
function steamAppId(gameId) {
    const id = BigInt(gameId);
    return String(id > 0xffffffffn ? id >> 32n : id);
}

const unquote = str => typeof str === 'string' ? str.replace(/^"(.*)"$/, '$1') || null : null;

// The icon Steam shows for a game in its library, which it keeps for any
// game: appcache/librarycache/<id>/<sha1>.jpg (<id>_icon.jpg before 2024).
// Only 32 px.
function steamLibraryIcon({id}) {
    for (const root of steamRoots()) {
        const dir = `${root}/appcache/librarycache/${[id].flat()[0]}`;
        const icon = listDir(dir).find(name => /^[0-9a-f]{40}\.jpg$/.test(name));
        if (icon)
            return `${dir}/${icon}`;
        if (exists(`${dir}_icon.jpg`))
            return `${dir}_icon.jpg`;
    }
    return null;
}

const COMPAT_DATA = /\/compatdata\/(?<id>[1-9]\d*)(?:\/pfx)?\/?$/;
const STEAM_ID = /^(?<id>[1-9]\d*)$/;

// --- Heroic

const HEROIC = 'com.heroicgameslauncher.hgl';
const heroicRoots = () => both(HEROIC, [configDir('heroic')], [['config', 'heroic']]);

// Per store, relative to a root.
const HEROIC_STORES = [
    'legendaryConfig/legendary/installed.json',
    'gog_store/installed.json',
    'nile_config/nile/installed.json',
    'sideload_apps/library.json',
];

function decode(str) {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

// The stores' files differ in shape:
//   legendary: {<app_name>: {app_name, title, install_path, executable}}
//   gog:       {installed: [{appName, install_path}]}
//   nile:      [{id, path}]
//   sideload:  {games: [{app_name, title, install: {executable}}]}
export function heroicGames(json, path) {
    let list = Object.values(json ?? {});
    if (Array.isArray(json))
        list = json;
    else if (Array.isArray(json?.installed))
        list = json.installed;
    else if (Array.isArray(json?.games))
        list = json.games;
    const root = path.slice(0, path.indexOf('/', path.lastIndexOf('/heroic/') + 1));
    return list.map(game => {
        const appName = game?.app_name ?? game?.appName ?? game?.id;
        // A shortcut (.lnk) given as its executable: the program it starts.
        const exe = typeof game?.install?.executable === 'string' ? programOf(game.install.executable) : null;
        const dir = game?.install_path ?? game?.path ?? null;
        const relative = typeof game?.executable === 'string' && dir ? `${dir}/${game.executable}` : null;
        if (!appName || !(dir || exe))
            return null;
        return {
            fields: {appName: String(appName)},
            name: game.title ?? null,
            dir,
            exe: exe ?? relative,
            icon: firstExisting(['png', 'jpg', 'jpeg', 'webp'].map(ext => `${root}/icons/${appName}.${ext}`)),
        };
    });
}

// --- Lutris

const LUTRIS = 'net.lutris.Lutris';

// <slug>-<timestamp>.yml: its game section holds the program and prefix.
export function lutrisGame(config, path) {
    const game = config?.game ?? {};
    const prefix = canonical(game.prefix);
    return {
        fields: {slug: basename(path).replace(/\.ya?ml$/, '').replace(/-\d+$/, '')},
        prefix,
        exe: typeof game.exe === 'string' ? programOf(game.exe, prefix) : null,
        dir: typeof game.exe === 'string' ? null : game.working_dir ?? null,
    };
}

// --- Bottles

const BOTTLES = 'com.usebottles.bottles';
const bottleRoots = () => both(BOTTLES, [dataDir('bottles', 'bottles')], [['data', 'bottles', 'bottles']]);

// bottle.yml -> the bottle itself (a prefix Bottles made) and each of its
// programs. A bottle is known by its path, its folder and its Name; a
// program by its name and its .exe, and a shortcut (.lnk) also by the
// program it starts (Battle.net.lnk starts "Battle.net Launcher.exe",
// which starts Battle.net.exe and quits: its own name comes first).
export function bottlePrograms(config, path) {
    const dir = GLib.path_get_dirname(path);
    const bottle = [dir, basename(dir), config?.Name].filter(Boolean);
    const name = config?.Name ?? basename(dir);
    const programs = Object.values(config?.External_Programs ?? {}).flatMap(program => {
        const exe = program?.executable || program?.path;
        if (!program?.name || typeof exe !== 'string')
            return [];
        const runs = /\.lnk$/i.test(exe) && typeof program.path === 'string' ? programOf(program.path) : null;
        return [{
            fields: {bottle, program: program.name},
            name: program.name,
            bottleName: name,
            folder: basename(dir),
            prefix: dir,
            exe: canonical(program.path),
            stems: [exeStem(exe), runs && exeStem(runs)].filter(Boolean),
            icon: `${dir}/icons/${program.name}.png`,
            hidden: program.removed === 'true',
        }];
    });
    return [{fields: {bottle}, bottleName: name, folder: basename(dir), prefix: dir}, ...programs];
}

// --- The launchers, strongest signals first: a Heroic game may also carry
// a Steam id through umu.

export const LAUNCHERS = [
    {
        name: 'heroic',
        sandbox: HEROIC,
        shortcut: {
            // heroic://launch/<runner>/<appName>, heroic://launch/<appName>
            // (older), heroic://launch?appName=<appName>&runner=... (newer)
            exec: [
                /heroic:\/\/launch\/(?:(?:legendary|gog|nile|sideload)\/)?(?<appName>[^\s?&"'/]+)/,
                /heroic:\/\/launch\?[^\s"']*?\bappName=(?<appName>[^\s&"']+)/,
            ],
            normalize: ({appName}) => ({appName: decode(appName)}),
        },
        binaries: ['heroic'],
        window: [{env: 'HEROIC_APP_NAME', field: 'appName'}],
        launchedBy: [{env: 'HEROIC_APP_NAME'}],
        key: 'appName',
        library: [
            {
                files: () => heroicRoots().flatMap(root => HEROIC_STORES.map(file => `${root}/${file}`)),
                format: 'json',
                records: heroicGames,
            },
            {
                // GamesConfig/<appName>.json: {<appName>: {winePrefix}}
                dirs: () => heroicRoots().map(root => `${root}/GamesConfig`),
                match: /\.json$/,
                format: 'json',
                records: (json, path) => {
                    const appName = basename(path).replace(/\.json$/, '');
                    return {fields: {appName}, prefix: json?.[appName]?.winePrefix ?? null};
                },
            },
        ],
    },
    {
        name: 'steam',
        sandbox: STEAM,
        shortcut: {
            // steam://rungameid/<game id>, steam://run/<app id>
            exec: /steam:\/\/(?:rungameid|run)\/(?<id>\d+)/,
            hint: [{from: 'icon', re: /^steam_icon_(?<id>\d+)$/}],
            normalize: ({id}) => ({id: steamAppId(id)}),
        },
        // Steam itself, and the runtime it runs Linux games in.
        binaries: ['steam', 'steam.exe', 'reaper', 'pressure-vessel-wrap', 'steam-runtime-launcher-service',
            'pv-adverb', 'srt-bwrap'],
        sharedDirs: ['steamapps'],
        window: [
            {class: true, re: /^steam_app_(?<id>[1-9]\d*)$/i},
            {env: 'SteamAppId', re: STEAM_ID},
            {env: 'SteamGameId', re: STEAM_ID},
            {env: 'STEAM_COMPAT_DATA_PATH', re: COMPAT_DATA},
            {prefix: true, re: COMPAT_DATA},
            // Last: umu's ids follow Steam's only for games its database knows.
            {env: 'GAMEID', re: /^umu-(?<id>[1-9]\d*)$/},
        ],
        // umu (Heroic, Lutris) sets SteamAppId too, along with GAMEID.
        launchedBy: [{env: 'SteamAppId', re: STEAM_ID, unless: 'GAMEID'}],
        iconName: 'steam_icon_{id}',
        extraIcon: steamLibraryIcon,
        key: 'id',
        library: [
            {
                // Installed games: <library>/steamapps/appmanifest_<id>.acf
                dirs: () => steamLibraries().map(lib => `${lib}/steamapps`),
                match: /^appmanifest_\d+\.acf$/,
                format: 'vdf',
                records: (vdf, path) => {
                    const app = vdf.appstate;
                    return app?.appid && app.installdir ? {
                        fields: {id: app.appid},
                        name: app.name ?? null,
                        dir: `${GLib.path_get_dirname(path)}/common/${app.installdir}`,
                    } : null;
                },
            },
            {
                // Non-Steam games: userdata/<account>/config/shortcuts.vdf.
                // Steam names them "Game.exe" by default.
                files: () => steamRoots().flatMap(root =>
                    listDir(`${root}/userdata`).map(user => `${root}/userdata/${user}/config/shortcuts.vdf`)),
                format: 'binvdf',
                records: vdf => Object.values(vdf.shortcuts ?? {}).filter(s => typeof s.appid === 'number').map(s => ({
                    fields: {id: String(s.appid >>> 0)},
                    name: s.appname?.replace(/\.(exe|lnk)$/i, '') || null,
                    exe: programOf(unquote(s.exe)),
                    icon: /\.(png|svg|jpe?g)$/i.test(unquote(s.icon) ?? '') ? unquote(s.icon) : null,
                })),
            },
        ],
        mirror: {
            setting: 'flatpak-steam',
            prefix: 'steam-flatpak-',
            iconDir: () => dataDir('icon-fix', 'icons'),
            title: 'Flatpak Steam',
            description: 'Steam from Flathub keeps its game shortcuts inside its sandbox, ' +
                'so GNOME can\'t find them. This copies them to ' +
                '~/.local/share/applications as steam-flatpak-*.desktop files ' +
                'that launch through Flatpak. Your own .desktop files are never touched.',
            switchTitle: 'Show Flatpak Steam games',
            // Its own shortcuts, and those of "Add desktop shortcut".
            shortcuts: () => [sandboxDir(STEAM, '.local', 'share', 'applications'), sandboxDir(STEAM, 'Desktop')],
            wmClass: 'steam_app_{id}',
        },
    },
    {
        name: 'bottles',
        sandbox: BOTTLES,
        shortcut: {
            // `[flatpak run --command=bottles-cli com.usebottles.bottles]
            // bottles-cli run -p <program> -b <bottle>`, or the older
            // `bottles -e <exe> -b <bottle>`. -b: the bottle's path, folder
            // or Name.
            options: {
                commands: ['bottles-cli', 'bottles', '--command=bottles-cli', '--command=bottles', BOTTLES],
                flags: {
                    '-p': 'program', '--program': 'program', '-b': 'bottle', '--bottle': 'bottle',
                    '-e': 'exe', '--executable': 'exe',
                },
            },
            normalize: ({bottle, program, exe}) => bottle && (program || exe)
                ? {bottle: canonical(bottle) ?? bottle, ...program ? {program} : {}, ...exe ? {exe: exeStem(exe)} : {}}
                : null,
        },
        binaries: ['bottles', 'bottles-cli'],
        window: [{env: 'BOTTLE', field: 'bottle'}],
        launchedBy: [{env: 'BOTTLE'}],
        library: [{
            files: () => bottleRoots().flatMap(root => listDir(root).map(name => `${root}/${name}/bottle.yml`)),
            format: 'yaml',
            records: bottlePrograms,
        }],
        mirror: {
            setting: 'flatpak-bottles',
            prefix: 'bottles-flatpak-',
            iconDir: () => dataDir('icon-fix', 'bottles-icons'),
            title: 'Flatpak Bottles',
            description: 'Bottles from Flathub can\'t add its programs to the app grid ' +
                'from its sandbox. This creates a shortcut for each program in your bottles, ' +
                'as bottles-flatpak-*.desktop files in ~/.local/share/applications. ' +
                'Your own .desktop files are never touched.',
            switchTitle: 'Show Flatpak Bottles programs',
            // A shortcut for each program shown in Bottles, run the way its
            // own shortcuts run it.
            games: game => !!game.fields.program && !game.hidden,
            file: game => [game.folder, game.fields.program[0]],
            exec: game => ['--command=bottles-cli', BOTTLES, 'run', '-p', game.fields.program[0], '-b', game.bottleName],
            name: game => game.fields.program[0],
            comment: game => `Run in Bottles (${game.bottleName})`,
            wmClass: '{exe}',
            // A running program makes Wine rewrite its bottle's registry
            // every few seconds; only bottle.yml and the icons matter.
            watch: () => bottleRoots().filter(root => root.includes('/.var/app/'))
                .flatMap(root => [root, ...listDir(root).map(name => `${root}/${name}`)]),
            relevant: /^(bottle\.yml|icons)$/,
        },
    },
    {
        name: 'lutris',
        sandbox: LUTRIS,
        shortcut: {
            // lutris:rungameid/<id> or lutris:rungame/<slug>; its own
            // shortcuts are net.lutris.<slug>-<id>.desktop, Icon=lutris_<slug>.
            exec: /lutris:(?:rungameid\/\d+|rungame\/(?<slug>[\w.-]+))/,
            also: [{from: 'id', re: /^net\.lutris\.(?<slug>.+)-\d+\.desktop$/}, {from: 'icon', re: /^lutris_(?<slug>.+)$/}],
        },
        binaries: ['lutris'],
        launchedBy: [{env: 'LUTRIS_GAME_UUID'}],
        nameEnv: 'GAME_NAME',
        iconName: 'lutris_{slug}',
        key: 'slug',
        library: [{
            dirs: () => both(LUTRIS, [configDir('lutris', 'games'), dataDir('lutris', 'games')],
                [['config', 'lutris', 'games'], ['data', 'lutris', 'games']]),
            match: /\.ya?ml$/,
            format: 'yaml',
            records: lutrisGame,
        }],
    },
];

for (const desc of LAUNCHERS) {
    for (const name of desc.binaries ?? [])
        GENERIC_BINARIES.add(name);
    for (const name of desc.sharedDirs ?? [])
        SHARED_DIR_NAMES.add(name);
}
