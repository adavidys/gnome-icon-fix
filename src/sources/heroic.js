// Heroic Games Launcher (native or Flatpak): Epic (Legendary), GOG, Amazon
// (Nile) and sideloaded games.
//
// Its shortcuts run heroic://launch/... with the game's appName. A running
// game is told apart by HEROIC_APP_NAME (some versions export it), by the
// Wine prefix Heroic made for it (GamesConfig/<appName>.json), or by its
// install folder from the stores' installed.json.

import GdkPixbuf from 'gi://GdkPixbuf';

import {guessPaths} from '../lib/matcher.js';
import {exeInfo} from '../lib/peicon.js';
import {
    StampCache, basename, canonical, configDir, exists, home, isSpecificDir, isUnder, listDir, pathKey, readJson,
} from '../lib/util.js';

const SANDBOX = 'com.heroicgameslauncher.hgl';

function roots() {
    return [
        configDir('heroic'),
        home('.var', 'app', SANDBOX, 'config', 'heroic'),
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
    if (!appName)
        return null;
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
    const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
    return Math.abs(Math.log(width / height)) < 0.25;
}

function decode(str) {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
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

export class HeroicSource {
    constructor() {
        this.name = 'heroic';
        this.sandbox = SANDBOX;
        this.envKeys = ['HEROIC_APP_NAME'];
        this._installed = new StampCache(path => installedGames(readJson(path)));
        this._configLists = new StampCache(dir => listDir(dir).filter(name => name.endsWith('.json')));
        this._configs = new StampCache(path => {
            const appName = basename(path).replace(/\.json$/, '');
            return {appName, prefix: gamePrefix(appName, readJson(path))};
        });
    }

    indexEntry(entry, _argv, index) {
        const m = entry.exec?.match(LAUNCH);
        if (!m)
            return false;
        index.add(index.map('heroic'), decode(m[1] ?? m[2]), entry.id);
        return true;
    }

    // Native Heroic runs games outside any sandbox and doesn't always say
    // so in their environment; the prefix it made for them does.
    launched(ctx) {
        return !!ctx.env.HEROIC_APP_NAME || this._appsInPrefix(ctx).length > 0;
    }

    identify(ctx, index) {
        const shortcuts = index.map('heroic');
        const byEnv = index.find(shortcuts, ctx.env.HEROIC_APP_NAME, ctx);
        if (byEnv)
            return {id: byEnv};

        const id = index.find(shortcuts, this._game(ctx)?.appName, ctx);
        return id ? {id} : null;
    }

    entryIcon(entry) {
        const m = entry.exec?.match(LAUNCH);
        const appName = m && decode(m[1] ?? m[2]);
        return appName ? this._icon(appName, this._games().find(g => g.appName === appName)?.exe) : null;
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
        return (exe && exists(exe) ? exeInfo(exe)?.icon : null) ?? saved;
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
        if (ctx.heroicApps === undefined) {
            const keys = [ctx.prefix, canonical(ctx.env.STEAM_COMPAT_DATA_PATH)].filter(Boolean)
                .map(pathKey).flatMap(p => p.endsWith('/pfx') ? [p, p.slice(0, -4)] : [p]);
            ctx.heroicApps = keys.length ? roots().flatMap(root => {
                const dir = `${root}/GamesConfig`;
                return (this._configLists.get(dir) ?? []).map(name => this._configs.get(`${dir}/${name}`));
            }).filter(c => c?.prefix && keys.includes(c.prefix)).map(c => c.appName) : [];
        }
        return ctx.heroicApps;
    }

    _game(ctx) {
        if (ctx.heroic !== undefined)
            return ctx.heroic;
        const appName = ctx.env.HEROIC_APP_NAME;
        const inPrefix = this._appsInPrefix(ctx);
        const where = guessPaths(ctx, this);
        let game = null;
        if (appName || inPrefix.length || where.length) {
            const games = this._games(ctx.launcherSandbox === SANDBOX);
            const named = name => games.find(g => g.appName === name) ?? {appName: name, title: null};
            // Several games may share a prefix: then their folders decide.
            const candidates = inPrefix.length ? games.filter(g => inPrefix.includes(g.appName)) : games;
            game = (appName && named(appName)) ||
                (inPrefix.length === 1 && named(inPrefix[0])) ||
                candidates.find(g => where.some(path => isUnder(path, g.dir))) ||
                null;
        }
        ctx.heroic = game;
        return game;
    }
}
