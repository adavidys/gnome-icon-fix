// Lutris (native or Flatpak).
//
// Its shortcuts run lutris:rungameid/<id> and are named
// net.lutris.<slug>-<id>.desktop with Icon=lutris_<slug>. Each game has a
// <slug>-<timestamp>.yml config whose `game` section holds the exe and Wine
// prefix, which is how a running game is recognized. Lutris exports the
// game's name as GAME_NAME.

import {parseYaml} from '../lib/formats.js';
import {guessPaths} from '../lib/matcher.js';
import {exeInfo} from '../lib/peicon.js';
import {
    StampCache, basename, canonical, configDir, dataDir, exeStem, exists, findHicolorIcon, home,
    isSpecificDir, isUnder, listDir, pathKey, readText,
} from '../lib/util.js';

const SANDBOX = 'net.lutris.Lutris';

function flatpakDir(...parts) {
    return home('.var', 'app', SANDBOX, ...parts);
}

function gameDirs() {
    return [
        configDir('lutris', 'games'),
        dataDir('lutris', 'games'),
        flatpakDir('config', 'lutris', 'games'),
        flatpakDir('data', 'lutris', 'games'),
    ];
}

const RUN = /lutris:(?:rungameid\/\d+|rungame\/([\w.-]+))/;

// The game slug a Lutris entry runs: null if it doesn't say, undefined if
// it isn't a Lutris entry.
function slugOf(entry) {
    const m = entry.exec?.match(RUN);
    if (!m)
        return undefined;
    return m[1] ??
        entry.id.match(/^net\.lutris\.(.+)-\d+\.desktop$/)?.[1] ??
        entry.icon?.match(/^lutris_(.+)$/)?.[1] ??
        null;
}

// <slug>-<timestamp>.yml -> {slug, stem, prefix, dir, exe}
export function gameFromConfig(path, config) {
    const game = config.game ?? {};
    const exe = typeof game.exe === 'string' ? game.exe : null;
    const exePath = canonical(exe);
    const dir = exePath ? exePath.slice(0, exePath.lastIndexOf('/')) : canonical(game.working_dir);
    return {
        slug: basename(path).replace(/\.ya?ml$/, '').replace(/-\d+$/, ''),
        stem: exe ? exeStem(exe) : null,
        prefix: canonical(game.prefix),
        dir: isSpecificDir(dir) ? pathKey(dir) : null,
        exe: exePath,
    };
}

export class LutrisSource {
    constructor() {
        this.name = 'lutris';
        this.sandbox = SANDBOX;
        this.envKeys = ['GAME_NAME', 'LUTRIS_GAME_UUID'];
        // Configs are rewritten in place, so each one is checked on its own;
        // the folder only tells us which ones exist.
        this._lists = new StampCache(dir => listDir(dir).filter(name => /\.ya?ml$/.test(name)));
        this._configs = new StampCache(path => gameFromConfig(path, parseYaml(readText(path))));
    }

    indexEntry(entry, _argv, index) {
        const slug = slugOf(entry);
        if (slug === undefined)
            return false;
        if (slug)
            index.add(index.map('lutris'), slug, entry.id);
        return true;
    }

    // Older versions don't set LUTRIS_GAME_UUID; a prefix Lutris made for
    // a game is as sure a sign.
    // Its lutris_<slug> icon, else the game's .exe.
    entryIcon(entry) {
        const slug = slugOf(entry);
        if (!slug)
            return null;
        const icon = findHicolorIcon(dataDir(), `lutris_${slug}`) ?? findHicolorIcon(flatpakDir('data'), `lutris_${slug}`);
        const exe = !icon && this._games().find(g => g.slug === slug)?.exe;
        return icon ?? (exe && exists(exe) ? exeInfo(exe)?.icon ?? null : null);
    }

    launched(ctx) {
        return !!ctx.env.LUTRIS_GAME_UUID ||
            (!!ctx.prefix && this._games().some(g => g.prefix === ctx.prefix));
    }

    identify(ctx, index) {
        const game = this._game(ctx);
        const id = game && index.find(index.map('lutris'), game.slug, ctx);
        return id ? {id} : null;
    }

    fallback(ctx) {
        const game = this._game(ctx);
        if (!game)
            return null;
        const iconName = `lutris_${game.slug}`;
        return {iconName, icon: findHicolorIcon(flatpakDir('data'), iconName), name: ctx.env.GAME_NAME || null};
    }

    _games() {
        return gameDirs().flatMap(dir => (this._lists.get(dir) ?? [])
            .map(name => this._configs.get(`${dir}/${name}`))
            .filter(Boolean));
    }

    _game(ctx) {
        if (ctx.lutris !== undefined)
            return ctx.lutris;
        const where = guessPaths(ctx, this);
        let game = null;
        if (ctx.prefix || where.length) {
            const games = this._games();
            game = games.find(g => g.prefix && g.prefix === ctx.prefix && ctx.stems.includes(g.stem)) ??
                games.find(g => g.dir && where.some(path => isUnder(path, g.dir))) ??
                null;
        }
        ctx.lutris = game;
        return game;
    }
}
