// Steam (native, Flatpak, Snap) and everything it runs through Proton.
//
// A game's window is classed steam_app_<id> and its process carries
// SteamAppId/SteamGameId; Proton prefixes live in compatdata/<id>; games run
// through umu-launcher get GAMEID=umu-<id>. Games started outside Steam are
// still found by their folder in a Steam library. Shortcut entries link to
// steam://rungameid/<id> and use the steam_icon_<id> icon, which is also
// what we show when a game has no entry at all.

import GLib from 'gi://GLib';

import {parseBinaryVdf, parseVdf} from '../lib/formats.js';
import {guessPaths} from '../lib/matcher.js';
import {exeInfo} from '../lib/peicon.js';
import {
    StampCache, canonical, dataDir, exists, findHicolorIcon, home, isUnder, listDir, pathKey, readText,
} from '../lib/util.js';

function flatpakShare() {
    return home('.var', 'app', 'com.valvesoftware.Steam', '.local', 'share');
}

function steamRoots() {
    return [
        dataDir('Steam'),
        // A link to the real root on most distributions, the root itself
        // on Debian's package (~/.steam/debian-installation).
        home('.steam', 'steam'),
        GLib.build_filenamev([flatpakShare(), 'Steam']),
        home('snap', 'steam', 'common', '.local', 'share', 'Steam'),
    ];
}

// Non-Steam games added to Steam: [{id, name, exe, icon}] from a
// userdata/<user>/config/shortcuts.vdf. id is the 32-bit app id their
// windows are classed with (the upper half of the 64-bit game id).
export function readShortcuts(path) {
    let bytes;
    try {
        bytes = GLib.file_get_contents(path)[1];
    } catch {
        return [];
    }
    const unquote = str => typeof str === 'string' ? str.replace(/^"(.*)"$/, '$1') || null : null;
    return Object.values(parseBinaryVdf(bytes).shortcuts ?? {})
        .filter(s => typeof s?.appid === 'number')
        .map(s => ({
            id: String(s.appid >>> 0),
            name: s.appname || null,
            exe: unquote(s.exe),
            icon: unquote(s.icon),
        }));
}

// All shortcuts.vdf files of a Steam root, one per Steam account used.
export function shortcutFiles(root) {
    return listDir(`${root}/userdata`).map(user => `${root}/userdata/${user}/config/shortcuts.vdf`);
}

// What to show for a non-Steam game: Steam's name for it ("Game.exe" by
// default: the extension isn't worth showing) and its icon, the one picked
// in Steam or the .exe's own. dir: where to save an icon from an .exe.
export function shortcutLook(shortcut, dir) {
    const name = shortcut.name?.replace(/\.exe$/i, '') || null;
    let icon = null;
    for (const file of [shortcut.icon, shortcut.exe].filter(Boolean)) {
        if (/\.exe$/i.test(file))
            icon = exeInfo(file, dir)?.icon ?? null;
        else if (/\.(png|svg|jpe?g)$/i.test(file) && exists(file))
            icon = file;
        if (icon)
            break;
    }
    return {name, icon};
}

// ".../steamapps/compatdata/<id>" or ".../compatdata/<id>/pfx" -> id
const COMPAT_DATA = /\/compatdata\/(\d+)(?:\/pfx)?\/?$/;

function resolveLink(path) {
    try {
        const target = GLib.file_read_link(path);
        return canonical(target.startsWith('/') ? target : `${path}/../${target}`);
    } catch {
        return canonical(path);
    }
}

export class SteamSource {
    constructor() {
        this.name = 'steam';
        this.sandbox = 'com.valvesoftware.Steam';
        this.envKeys = ['SteamAppId', 'SteamGameId', 'STEAM_COMPAT_DATA_PATH', 'GAMEID'];

        // libraryfolders.vdf -> library folders it lists
        this._folders = new StampCache(path => {
            const folders = parseVdf(readText(path) ?? '').libraryfolders ?? {};
            // Old format: "1" "/path"; current: "0" { "path" "/path" ... }
            return Object.values(folders)
                .map(f => canonical(typeof f === 'string' ? f : f?.path))
                .filter(Boolean);
        });
        this._shortcuts = new StampCache(readShortcuts);
        // <library>/steamapps -> [{id, name, dir}], reparsed when a manifest
        // is added, removed or replaced (Steam rewrites them by renaming).
        this._manifests = new StampCache(steamapps => listDir(steamapps)
            .filter(name => /^appmanifest_\d+\.acf$/.test(name))
            .map(name => parseVdf(readText(`${steamapps}/${name}`) ?? '').appstate)
            .filter(app => app?.appid && app.installdir)
            .map(app => ({
                id: app.appid,
                name: app.name ?? null,
                dir: pathKey(`${steamapps}/common/${app.installdir}`),
            })));
    }

    indexEntry(entry, _argv, index) {
        const steam = index.map('steam');
        const icon = entry.icon?.match(/^steam_icon_(\d+)$/);
        if (icon)
            index.add(steam, icon[1], entry.id);

        const run = entry.exec?.match(/steam:\/\/(?:rungameid|run)\/(\d+)/);
        if (!run)
            return false;
        index.add(steam, run[1], entry.id);
        // Non-Steam shortcuts launch by a 64-bit game id whose upper half is
        // the app id used in steam_app_<id>.
        const gameId = BigInt(run[1]);
        if (gameId > 0xffffffffn)
            index.add(steam, String(gameId >> 32n), entry.id);
        return true;
    }

    // umu (Heroic, Lutris) sets SteamAppId too, along with GAMEID.
    launched(ctx) {
        return /^[1-9]\d*$/.test(ctx.env.SteamAppId ?? '') && !ctx.env.GAMEID;
    }

    identify(ctx, index) {
        const steam = index.map('steam');
        const ids = this._ids(ctx);
        ctx.steamIds = ids;
        for (const id of ids) {
            if (steam.has(id))
                return {id: steam.get(id)};
        }

        // Started outside Steam, or its environment couldn't be read: the
        // files still live in a Steam library.
        const game = this._gameAt(ctx);
        if (!game)
            return null;
        if (!ids.includes(game.id))
            ids.push(game.id);
        return steam.has(game.id) ? {id: steam.get(game.id)} : null;
    }

    fallback(ctx) {
        const id = ctx.steamIds?.[0];
        if (!id)
            return null;
        const shortcut = this._nonSteamGames().find(s => s.id === id);
        if (shortcut)
            return shortcutLook(shortcut);
        const iconName = `steam_icon_${id}`;
        return {
            iconName,
            // Flatpak Steam keeps its icons where the icon theme can't see them.
            icon: findHicolorIcon(flatpakShare(), iconName),
            name: this._games().find(g => g.id === id)?.name ?? null,
        };
    }

    _ids(ctx) {
        const ids = [];
        // umu sets SteamAppId=default (and the class steam_app_default) for
        // games it has no id for.
        const add = id => {
            if (/^\d+$/.test(id ?? '') && id !== '0' && !ids.includes(id))
                ids.push(id);
        };
        add(ctx.wmClass?.match(/^steam_app_(\d+)$/i)?.[1]);
        add(ctx.env.SteamAppId);
        add(ctx.env.SteamGameId);
        add(ctx.env.STEAM_COMPAT_DATA_PATH?.match(COMPAT_DATA)?.[1]);
        add(ctx.prefix?.match(COMPAT_DATA)?.[1]);
        // Last: umu ids follow Steam's only for games the umu database knows.
        add(ctx.env.GAMEID?.match(/^umu-(\d+)$/)?.[1]);
        return ids;
    }

    // The real Steam roots: ~/.steam/steam is usually a link to another.
    _roots() {
        return new Set(steamRoots().map(resolveLink).filter(Boolean));
    }

    _libraries() {
        const libraries = new Set();
        for (const root of this._roots()) {
            for (const folder of this._folders.get(`${root}/steamapps/libraryfolders.vdf`) ?? [])
                libraries.add(folder);
            // Old libraryfolders.vdf files don't list the root itself.
            libraries.add(root);
        }
        return libraries;
    }

    _nonSteamGames() {
        return [...this._roots()].flatMap(root =>
            shortcutFiles(root).flatMap(path => this._shortcuts.get(path) ?? []));
    }

    _games() {
        return [...this._libraries()].flatMap(lib => this._manifests.get(`${lib}/steamapps`) ?? []);
    }

    _gameAt(ctx) {
        const where = guessPaths(ctx, this);
        if (!where.length)
            return null;
        return this._games().find(game => where.some(path => isUnder(path, game.dir))) ?? null;
    }
}
