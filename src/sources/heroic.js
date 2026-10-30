// Heroic Games Launcher (native or Flatpak): Epic (Legendary), GOG, Amazon
// (Nile) and sideloaded games.
//
// Its shortcuts run heroic://launch/... with the game's appName. A running
// game is told apart by HEROIC_APP_NAME (some versions export it), by the
// Wine prefix Heroic made for it (GamesConfig/<appName>.json), or by its
// install folder from the stores' installed.json.

import GdkPixbuf from 'gi://GdkPixbuf';

import {exeIcon} from '../lib/peicon.js';
import {
    FolderCache, StampCache, basename, canonical, configDir, exists, isSpecificDir, pathKey, readJson, sandboxDir,
} from '../lib/util.js';
import {LauncherSource} from './launcher.js';

const SANDBOX = 'com.heroicgameslauncher.hgl';

function roots() {
    return [
        configDir('heroic'),
        sandboxDir(SANDBOX, 'config', 'heroic'),
    ];
}

// Per store, relative to a root.
const INSTALLED = [
    'legendaryConfig/legendary/installed.json',
    'gog_store/installed.json',
    'nile_config/nile/installed.json',
    'sideload_apps/library.json',
];

// heroic://launch/<runner>/<appName>, heroic://launch/<appName> (older),
// heroic://launch?appName=<appName>&runner=<runner> (newer)
const LAUNCH = /heroic:\/\/launch(?:\/(?:(?:legendary|gog|nile|sideload)\/)?([^\s?&"'/]+)|\?[^\s"']*?\bappName=([^\s&"']+))/;

// Where Heroic saves the icons it uses for its shortcuts.
function iconOf(appName) {
    for (const root of roots()) {
        for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
            const path = `${root}/icons/${appName}.${ext}`;
            if (exists(path))
                return path;
        }
    }
    return null;
}

// Without a store icon (sideloaded games), Heroic saves the game's cover
// there: a tall picture, squeezed in the dock. The .exe's own icon is
// better then.
function looksLikeIcon(path) {
    const info = GdkPixbuf.Pixbuf.get_file_info(path);
    return Math.abs(Math.log(info[1] / info[2])) < 0.25;
}

function decode(str) {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

// The appName a shortcut launches, or null.
function launchedApp(entry) {
    const m = entry.exec?.match(LAUNCH);
    return m ? decode(m[1] ?? m[2]) : null;
}

// The stores' files differ in shape:
//   legendary: {<app_name>: {app_name, title, install_path}}
//   gog:       {installed: [{appName, install_path}]}
//   nile:      [{id, path}]
//   sideload:  {games: [{app_name, title, install: {executable}}]}
export function installedGames(json) {
    let list;
    if (Array.isArray(json))
        list = json;
    else if (Array.isArray(json?.installed))
        list = json.installed;
    else if (Array.isArray(json?.games))
        list = json.games;
    else
        list = Object.values(json ?? {});

    const games = [];
    for (const game of list) {
        const appName = game?.app_name ?? game?.appName ?? game?.id;
        const exe = game?.install?.executable;
        const dir = canonical(game?.install_path ?? game?.path ??
            (typeof exe === 'string' ? exe.slice(0, exe.lastIndexOf('/')) : null));
        // Sideloaded: install.executable; Legendary: executable, relative.
        const program = canonical(typeof exe === 'string' ? exe
            : typeof game?.executable === 'string' && dir ? `${dir}/${game.executable}` : null);
        if (appName && dir && isSpecificDir(dir))
            games.push({appName: String(appName), title: game.title ?? null, dir: pathKey(dir), exe: program});
    }
    return games;
}

// GamesConfig/<appName>.json ({<appName>: {winePrefix, ...}}) -> the prefix
// (pathKey'd) Heroic runs that game in, or null.
export function gamePrefix(appName, json) {
    const prefix = canonical(json?.[appName]?.winePrefix);
    return prefix ? pathKey(prefix) : null;
}

export class HeroicSource extends LauncherSource {
    constructor() {
        super('heroic', {sandbox: SANDBOX, envKeys: ['HEROIC_APP_NAME']});
        this._installed = new StampCache(path => installedGames(readJson(path)));
        // GamesConfig/ -> [{appName, prefix}]
        this._configs = new FolderCache(name => name.endsWith('.json'), path => {
            const appName = basename(path).replace(/\.json$/, '');
            return {appName, prefix: gamePrefix(appName, readJson(path))};
        });
    }

    entryKeys(entry) {
        const appName = launchedApp(entry);
        return appName ? [appName] : null;
    }

    entryIcon(entry) {
        const appName = launchedApp(entry);
        return appName ? this._icon(appName, this._games().find(g => g.appName === appName)?.exe) : null;
    }

    // Native Heroic runs games outside any sandbox and doesn't always say
    // so in their environment; the prefix it made for them does.
    launched(ctx) {
        return !!ctx.env.HEROIC_APP_NAME || this._appsInPrefix(ctx).length > 0;
    }

    *windowKeys(ctx) {
        yield ctx.env.HEROIC_APP_NAME;
        yield this._game(ctx)?.appName;
    }

    fallback(ctx) {
        const game = this._game(ctx);
        // Heroic knows no icon: the other sources' come first.
        const icon = game && iconOf(game.appName) ? this._icon(game.appName, game.exe) : null;
        return icon || game?.title ? {icon, name: game.title} : null;
    }

    // Heroic's icon for a game, unless it's a cover and its .exe has one;
    // the .exe's when Heroic has none.
    _icon(appName, exe) {
        const saved = iconOf(appName);
        if (saved && looksLikeIcon(saved))
            return saved;
        return exeIcon(exe) ?? saved;
    }

    // Native Heroic's games first, or the Flatpak's: both may know the same
    // game, in the same prefix.
    _games(flatpakFirst = false) {
        const all = roots();
        if (flatpakFirst)
            all.reverse();
        return all.flatMap(root => INSTALLED.flatMap(file => this._installed.get(`${root}/${file}`) ?? []));
    }

    // The appNames whose Heroic prefix the process runs in (Proton's
    // WINEPREFIX is <prefix>/pfx).
    _appsInPrefix(ctx) {
        return this.remember(ctx, 'heroicApps', () => {
            const keys = [ctx.prefix, canonical(ctx.env.STEAM_COMPAT_DATA_PATH)].filter(Boolean)
                .map(pathKey).flatMap(p => p.endsWith('/pfx') ? [p, p.slice(0, -4)] : [p]);
            return keys.length ? roots().flatMap(root => this._configs.get(`${root}/GamesConfig`))
                .filter(c => c.prefix && keys.includes(c.prefix)).map(c => c.appName) : [];
        });
    }

    _game(ctx) {
        return this.remember(ctx, 'heroic', () => {
            const appName = ctx.env.HEROIC_APP_NAME;
            const inPrefix = this._appsInPrefix(ctx);
            const games = () => this._games(ctx.launcherSandbox === SANDBOX);
            const named = name => games().find(g => g.appName === name) ?? {appName: name, title: null};
            if (appName)
                return named(appName);
            if (inPrefix.length === 1)
                return named(inPrefix[0]);
            // Several games may share a prefix: then their folders decide.
            return this.gameInFolder(ctx,
                () => inPrefix.length ? games().filter(g => inPrefix.includes(g.appName)) : games());
        });
    }
}
