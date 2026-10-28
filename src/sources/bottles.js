// Bottles (native or Flatpak).
//
// It launches programs as `bottles-cli run -p <name> -b <bottle>` and sets
// StartupWMClass to the program's display name, while the Wine window is
// classed after the .exe. The bottle's bottle.yml records each program's
// executable, and a running program's WINEPREFIX is the bottle's folder.

import {parseYaml} from '../lib/formats.js';
import {exeInfo} from '../lib/peicon.js';
import {StampCache, basename, canonical, dataDir, exeStem, exists, home, listDir, readText} from '../lib/util.js';

const FLAGS = {
    '-p': 'program', '--program': 'program',
    '-b': 'bottle', '--bottle': 'bottle',
    '-e': 'executable', '--executable': 'executable',
};

const BOTTLES_APP = 'com.usebottles.bottles';

// Native first, then Flatpak.
function bottleDirs() {
    return [
        dataDir('bottles', 'bottles'),
        home('.var', 'app', BOTTLES_APP, 'data', 'bottles', 'bottles'),
    ];
}

const LAUNCHERS = new Set([
    'bottles-cli', 'bottles', '--command=bottles-cli', '--command=bottles', 'com.usebottles.bottles',
]);

// `[flatpak run --command=bottles-cli com.usebottles.bottles] bottles-cli run
// -p <program> -b <bottle>`, or the older `bottles -e <exe> -b <bottle>`
// -> {program, bottle, executable}
export function parseBottlesExec(argv) {
    const cli = argv.findIndex(a => LAUNCHERS.has(a) || LAUNCHERS.has(basename(a)));
    if (cli < 0)
        return null;
    const out = {};
    for (let i = cli + 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--')
            break;
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const key = FLAGS[eq > 0 ? arg.slice(0, eq) : arg];
        if (key)
            out[key] = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    }
    return out.bottle && (out.program || out.executable) ? out : null;
}

// bottle.yml -> {name, programs: [{name, stem, path, removed}]}; removed:
// hidden in Bottles' program list.
export function bottleFromConfig(config) {
    const programs = [];
    for (const program of Object.values(config.External_Programs ?? {})) {
        const exe = program?.executable || program?.path;
        if (program?.name && typeof exe === 'string') {
            programs.push({
                name: program.name,
                stem: exeStem(exe),
                path: canonical(program.path),
                removed: program.removed === 'true',
            });
        }
    }
    return {name: config.Name ?? null, programs};
}

export class BottlesSource {
    constructor() {
        this.name = 'bottles';
        this.sandbox = BOTTLES_APP;
        this.envKeys = ['BOTTLE'];
        this._configs = new StampCache(path => bottleFromConfig(parseYaml(readText(path))));
    }

    indexEntry(entry, argv, index) {
        const launch = parseBottlesExec(argv);
        if (!launch)
            return false;
        // -b is the bottle's folder name or path (native Bottles) or its
        // Name (Flatpak Bottles); identify() tries all three.
        const ref = canonical(launch.bottle) ?? launch.bottle;
        const map = index.map('bottles');
        if (launch.program)
            index.add(map, `${ref}\n${launch.program}`, entry.id);
        if (launch.executable) {
            const stem = exeStem(launch.executable);
            index.add(map, `${ref}\nexe:${stem}`, entry.id);
            index.add(index.exec, stem, entry.id);
        }
        return true;
    }

    // A bottle is a prefix only Bottles makes.
    launched(ctx) {
        return !!ctx.env.BOTTLE || !!this._bottle(ctx);
    }

    identify(ctx, index) {
        const bottle = this._bottle(ctx);
        if (!bottle)
            return null;
        const map = index.map('bottles');
        const refs = [bottle.dir, basename(bottle.dir), bottle.name].filter(Boolean);
        for (const stem of ctx.stems) {
            const names = bottle.programs.filter(p => p.stem === stem).map(p => p.name);
            for (const ref of refs) {
                for (const key of [...names, `exe:${stem}`]) {
                    const id = index.find(map, `${ref}\n${key}`, ctx);
                    if (id)
                        return {id};
                }
            }
        }
        return null;
    }

    // The icon Bottles extracted from the program's .exe, else the .exe.
    entryIcon(_entry, argv) {
        const launch = parseBottlesExec(argv);
        if (!launch?.program)
            return null;
        // -b: the bottle's path, or its folder name (native) or Name
        // (Flatpak) under one of the bottles dirs.
        const ref = launch.bottle;
        // Native and Flatpak bottles may share names: look where this
        // entry's Bottles keeps them first.
        const roots = bottleDirs();
        if (argv.includes(BOTTLES_APP))
            roots.reverse();
        const candidates = canonical(ref) ? [canonical(ref)]
            : roots.flatMap(root => listDir(root).map(name => `${root}/${name}`));
        for (const dir of candidates) {
            const config = this._configs.get(`${dir}/bottle.yml`);
            if (!config || (dir !== canonical(ref) && basename(dir) !== ref && config.name !== ref))
                continue;
            const program = config.programs.find(p => p.name === launch.program);
            if (!program)
                continue;
            const icon = `${dir}/icons/${program.name}.png`;
            if (exists(icon))
                return icon;
            return program.path && exists(program.path) ? exeInfo(program.path)?.icon ?? null : null;
        }
        return null;
    }

    // A program added to Bottles but never given a desktop entry: Bottles
    // still extracted its icon from the .exe.
    fallback(ctx) {
        const bottle = this._bottle(ctx);
        const program = bottle?.programs.find(p => ctx.stems.includes(p.stem));
        return program ? {icon: `${bottle.dir}/icons/${program.name}.png`, name: program.name} : null;
    }

    _bottle(ctx) {
        if (ctx.bottle === undefined) {
            const config = ctx.prefix && this._configs.get(`${ctx.prefix}/bottle.yml`);
            ctx.bottle = config ? {dir: ctx.prefix, ...config} : null;
        }
        return ctx.bottle;
    }
}
