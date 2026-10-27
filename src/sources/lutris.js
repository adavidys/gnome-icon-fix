// Lutris (native or Flatpak).
//
// Its shortcuts run lutris:rungameid/<id> and are named
// net.lutris.<slug>-<id>.desktop with Icon=lutris_<slug>. Each game has a
// <slug>-<timestamp>.yml config whose `game` section holds the exe and Wine
// prefix, which is how a running game is recognized.

import {parseYaml} from '../lib/formats.js';
import {
    StampCache, basename, canonical, configDir, dataDir, exeStem, findHicolorIcon, home,
    isSpecificDir, isUnder, listDir, pathKey, readText,
} from '../lib/util.js';

function flatpakDir(...parts) {
    return home('.var', 'app', 'net.lutris.Lutris', ...parts);
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

// <slug>-<timestamp>.yml -> {slug, stem, prefix, dir}
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
    };
}

export class LutrisSource {
    constructor() {
        this.name = 'lutris';
        // Configs are rewritten in place, so each one is checked on its own;
        // the folder only tells us which ones exist.
        this._lists = new StampCache(dir => listDir(dir).filter(name => /\.ya?ml$/.test(name)));
        this._configs = new StampCache(path => gameFromConfig(path, parseYaml(readText(path))));
    }

    indexEntry(entry, _argv, index) {
        const m = entry.exec?.match(RUN);
        if (!m)
            return false;
        const slug = m[1] ??
            entry.id.match(/^net\.lutris\.(.+)-\d+\.desktop$/)?.[1] ??
            entry.icon?.match(/^lutris_(.+)$/)?.[1];
        if (slug)
            index.add(index.map('lutris'), slug, entry.id);
        return true;
    }

    identify(ctx, index) {
        const game = this._game(ctx);
        const id = game && index.map('lutris').get(game.slug);
        return id ? {id} : null;
    }

    fallback(ctx) {
        const game = this._game(ctx);
        if (!game)
            return null;
        const iconName = `lutris_${game.slug}`;
        return {iconName, icon: findHicolorIcon(flatpakDir('data'), iconName)};
    }

    _games() {
        return gameDirs().flatMap(dir => (this._lists.get(dir) ?? [])
            .map(name => this._configs.get(`${dir}/${name}`))
            .filter(Boolean));
    }

    _game(ctx) {
        if (ctx.lutris !== undefined)
            return ctx.lutris;
        const where = [...ctx.paths, ctx.cwd].filter(Boolean).map(pathKey);
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
