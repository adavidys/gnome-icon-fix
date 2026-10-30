// Lutris (native or Flatpak).
//
// Its shortcuts run lutris:rungameid/<id> and are named
// net.lutris.<slug>-<id>.desktop with Icon=lutris_<slug>. Each game has a
// <slug>-<timestamp>.yml config whose `game` section holds the exe and Wine
// prefix, which is how a running game is recognized. Lutris exports the
// game's name as GAME_NAME.

import {parseYaml} from '../lib/formats.js';
import {exeIcon} from '../lib/peicon.js';
import {
    FolderCache, basename, canonical, configDir, dataDir, exeStem, findHicolorIcon, isSpecificDir, pathKey,
    readText, sandboxDir,
} from '../lib/util.js';
import {LauncherSource} from './launcher.js';

const SANDBOX = 'net.lutris.Lutris';

function flatpakDir(...parts) {
    return sandboxDir(SANDBOX, ...parts);
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

export class LutrisSource extends LauncherSource {
    constructor() {
        super('lutris', {sandbox: SANDBOX, envKeys: ['GAME_NAME', 'LUTRIS_GAME_UUID']});
        // Configs are rewritten in place, so each one is checked on its own;
        // the folder only tells us which ones exist.
        this._configs = new FolderCache(name => /\.ya?ml$/.test(name),
            path => gameFromConfig(path, parseYaml(readText(path))));
    }

    entryKeys(entry) {
        const slug = slugOf(entry);
        if (slug === undefined)
            return null;
        return slug ? [slug] : [];
    }

    // Its lutris_<slug> icon, else the game's .exe.
    entryIcon(entry) {
        const slug = slugOf(entry);
        if (!slug)
            return null;
        return findHicolorIcon(dataDir(), `lutris_${slug}`) ??
            findHicolorIcon(flatpakDir('data'), `lutris_${slug}`) ??
            exeIcon(this._games().find(g => g.slug === slug)?.exe);
    }

    // Older versions don't set LUTRIS_GAME_UUID; a prefix Lutris made for
    // a game is as sure a sign.
    launched(ctx) {
        return !!ctx.env.LUTRIS_GAME_UUID ||
            (!!ctx.prefix && this._games().some(g => g.prefix === ctx.prefix));
    }

    windowKeys(ctx) {
        return [this._game(ctx)?.slug];
    }

    fallback(ctx) {
        const game = this._game(ctx);
        if (!game)
            return null;
        const iconName = `lutris_${game.slug}`;
        return {iconName, icon: findHicolorIcon(flatpakDir('data'), iconName), name: ctx.env.GAME_NAME || null};
    }

    _games() {
        return gameDirs().flatMap(dir => this._configs.get(dir));
    }

    // By its prefix and program, else by its folder.
    _game(ctx) {
        return this.remember(ctx, 'lutris', () =>
            (ctx.prefix && this._games().find(g => g.prefix === ctx.prefix && ctx.stems.includes(g.stem))) ||
            this.gameInFolder(ctx, () => this._games()));
    }
}
