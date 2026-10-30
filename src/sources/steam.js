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
import * as log from '../lib/log.js';
import {exeIcon} from '../lib/peicon.js';
import {
    FolderCache, StampCache, canonical, dataDir, exists, findHicolorIcon, home, listDir, pathKey, readText, sandboxDir,
} from '../lib/util.js';
import {LauncherSource} from './launcher.js';

const SANDBOX = 'com.valvesoftware.Steam';

function flatpakShare() {
    return sandboxDir(SANDBOX, '.local', 'share');
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
    let vdf;
    try {
        vdf = parseBinaryVdf(GLib.file_get_contents(path)[1]);
    } catch (e) {
        if (!(e instanceof GLib.Error))
            log.warn(`can't read ${path}: ${e}`);
        return [];
    }
    const unquote = str => typeof str === 'string' ? str.replace(/^"(.*)"$/, '$1') || null : null;
    return Object.values(vdf.shortcuts ?? {})
        .filter(s => typeof s.appid === 'number')
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

// What to show for a non-Steam game: Steam's name for it ("Game.exe" or
// "Game.lnk" by default: the extension isn't worth showing) and its icon, the one picked
// in Steam or the .exe's own. dir: where to save an icon from an .exe.
export function shortcutLook(shortcut, dir) {
    const name = shortcut.name?.replace(/\.(exe|lnk)$/i, '') || null;
    let icon = null;
    for (const file of [shortcut.icon, shortcut.exe].filter(Boolean)) {
        if (/\.(exe|lnk)$/i.test(file))
            icon = exeIcon(file, dir);
        else if (/\.(png|svg|jpe?g)$/i.test(file) && exists(file))
            icon = file;
        if (icon)
            break;
    }
    return {name, icon};
}

// ".../steamapps/compatdata/<id>" or ".../compatdata/<id>/pfx" -> id
const COMPAT_DATA = /\/compatdata\/(\d+)(?:\/pfx)?\/?$/;

// What a shortcut runs: steam://rungameid/<game id> or steam://run/<app id>
const RUN = /steam:\/\/(?:rungameid|run)\/(\d+)/;

function resolveLink(path) {
    try {
        const target = GLib.file_read_link(path);
        return canonical(target.startsWith('/') ? target : `${path}/../${target}`);
    } catch {
        return canonical(path);
    }
}

export class SteamSource extends LauncherSource {
    constructor() {
        super('steam', {sandbox: SANDBOX, envKeys: ['SteamAppId', 'SteamGameId', 'STEAM_COMPAT_DATA_PATH', 'GAMEID']});

        // libraryfolders.vdf -> library folders it lists
        this._folders = new StampCache(path => {
            const folders = parseVdf(readText(path) ?? '').libraryfolders ?? {};
            // Old format: "1" "/path"; current: "0" { "path" "/path" ... }
            return Object.values(folders)
                .map(f => canonical(typeof f === 'string' ? f : f.path))
                .filter(Boolean);
        });
        this._shortcuts = new StampCache(readShortcuts);
        // <library>/steamapps -> [{id, name, dir}] from its manifests (Steam
        // rewrites them by renaming)
        this._manifests = new FolderCache(name => /^appmanifest_\d+\.acf$/.test(name), path => {
            const app = parseVdf(readText(path) ?? '').appstate;
            if (!app?.appid || !app.installdir)
                return null;
            const dir = `${GLib.path_get_dirname(path)}/common/${app.installdir}`;
            return {id: app.appid, name: app.name ?? null, dir: pathKey(dir)};
        });
    }

    // Steam's own shortcuts are also known by their icon, steam_icon_<id>.
    indexEntry(entry, argv, index) {
        const icon = entry.icon?.match(/^steam_icon_(\d+)$/);
        if (icon)
            index.add(index.map(this.name), icon[1], entry.id);
        return super.indexEntry(entry, argv, index);
    }

    // Non-Steam shortcuts launch by a 64-bit game id whose upper half is
    // the app id used in steam_app_<id>.
    entryKeys(entry) {
        const run = entry.exec?.match(RUN);
        if (!run)
            return null;
        const gameId = BigInt(run[1]);
        return gameId > 0xffffffffn ? [run[1], String(gameId >> 32n)] : [run[1]];
    }

    // Non-Steam games: the icon picked in Steam or the .exe's own. Steam
    // games: their steam_icon_<id>, wherever Steam put it.
    entryIcon(entry) {
        const gameId = entry.exec?.match(RUN)?.[1];
        if (!gameId)
            return null;
        if (BigInt(gameId) > 0xffffffffn) {
            const id = String(BigInt(gameId) >> 32n);
            const shortcut = this._nonSteamGames().find(s => s.id === id);
            return shortcut ? shortcutLook(shortcut).icon : null;
        }
        const name = `steam_icon_${gameId}`;
        return findHicolorIcon(dataDir(), name) ?? findHicolorIcon(flatpakShare(), name) ??
            this._libraryIcon(gameId);
    }

    // umu (Heroic, Lutris) sets SteamAppId too, along with GAMEID.
    launched(ctx) {
        return /^[1-9]\d*$/.test(ctx.env.SteamAppId ?? '') && !ctx.env.GAMEID;
    }

    *windowKeys(ctx) {
        const ids = this._ids(ctx);
        ctx.steamIds = ids;
        // (Not for...of: gjs counts a branch for leaving it early.)
        for (let i = 0; i < ids.length; i++)
            yield ids[i];
        // Started outside Steam, or its environment couldn't be read: the
        // files still live in a Steam library.
        const game = this._gameAt(ctx);
        if (game && !ids.includes(game.id)) {
            ids.push(game.id);
            yield game.id;
        }
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
            // Flatpak Steam keeps its icons where the icon theme can't see
            // them. Without a shortcut icon: Steam's library icon, unless the
            // game runs through Proton, whose .exe has a sharper one.
            icon: findHicolorIcon(flatpakShare(), iconName) ?? (ctx.wine ? null : this._libraryIcon(id)),
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

    // The icon Steam shows for a game in its library, which it keeps for
    // every game, shortcut or not: appcache/librarycache/<id>/<sha1>.jpg
    // (<id>_icon.jpg before 2024). Only 32 px.
    _libraryIcon(id) {
        for (const root of this._roots()) {
            const dir = `${root}/appcache/librarycache/${id}`;
            const icon = listDir(dir).find(name => /^[0-9a-f]{40}\.jpg$/.test(name));
            if (icon)
                return `${dir}/${icon}`;
            if (exists(`${dir}_icon.jpg`))
                return `${dir}_icon.jpg`;
        }
        return null;
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
        return this.gameInFolder(ctx, () => this._games());
    }
}
