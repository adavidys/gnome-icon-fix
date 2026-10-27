// Heroic Games Launcher (native or Flatpak): Epic (Legendary), GOG, Amazon
// (Nile) and sideloaded games.
//
// Its shortcuts run heroic://launch/... with the game's appName. A running
// game is told apart by HEROIC_APP_NAME (exported by recent Heroic
// versions) or by its install folder from the stores' installed.json.

import {guessPaths} from '../lib/matcher.js';
import {exeInfo} from '../lib/peicon.js';
import {StampCache, canonical, configDir, exists, home, isSpecificDir, isUnder, pathKey, readJson} from '../lib/util.js';

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

export class HeroicSource {
    constructor() {
        this.name = 'heroic';
        this.sandbox = SANDBOX;
        this.envKeys = ['HEROIC_APP_NAME'];
        this._installed = new StampCache(path => installedGames(readJson(path)));
    }

    indexEntry(entry, _argv, index) {
        const m = entry.exec?.match(LAUNCH);
        if (!m)
            return false;
        index.add(index.map('heroic'), decode(m[1] ?? m[2]), entry.id);
        return true;
    }

    launched(ctx) {
        return !!ctx.env.HEROIC_APP_NAME;
    }

    identify(ctx, index) {
        const shortcuts = index.map('heroic');
        const appName = ctx.env.HEROIC_APP_NAME;
        if (appName && shortcuts.has(appName))
            return {id: shortcuts.get(appName)};

        const game = this._game(ctx);
        return game && shortcuts.has(game.appName) ? {id: shortcuts.get(game.appName)} : null;
    }

    entryIcon(entry) {
        const m = entry.exec?.match(LAUNCH);
        const appName = m && decode(m[1] ?? m[2]);
        const game = appName && this._games().find(g => g.appName === appName);
        return iconOf(appName) ?? (game?.exe && exists(game.exe) ? exeInfo(game.exe)?.icon ?? null : null);
    }

    fallback(ctx) {
        const game = this._game(ctx);
        return game ? {icon: iconOf(game.appName), name: game.title} : null;
    }

    _games() {
        return roots().flatMap(root => INSTALLED.flatMap(file => this._installed.get(`${root}/${file}`) ?? []));
    }

    _game(ctx) {
        if (ctx.heroic !== undefined)
            return ctx.heroic;
        const appName = ctx.env.HEROIC_APP_NAME;
        const where = guessPaths(ctx, this);
        let game = null;
        if (appName || where.length) {
            const games = this._games();
            game = (appName && games.find(g => g.appName === appName)) ||
                games.find(g => where.some(path => isUnder(path, g.dir))) ||
                (appName ? {appName, title: null} : null);
        }
        ctx.heroic = game;
        return game;
    }
}
