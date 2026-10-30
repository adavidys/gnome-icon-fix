// Bottles (native or Flatpak).
//
// It launches programs as `bottles-cli run -p <name> -b <bottle>` and sets
// StartupWMClass to the program's display name, while the Wine window is
// classed after the .exe. The bottle's bottle.yml records each program's
// executable, and a running program's WINEPREFIX is the bottle's folder.

import {parseYaml} from '../lib/formats.js';
import {programOf} from '../lib/lnk.js';
import {exeIcon} from '../lib/peicon.js';
import {StampCache, basename, canonical, dataDir, exeStem, exists, listDir, readText, sandboxDir} from '../lib/util.js';
import {LauncherSource} from './launcher.js';

const FLAGS = {
    '-p': 'program', '--program': 'program',
    '-b': 'bottle', '--bottle': 'bottle',
    '-e': 'executable', '--executable': 'executable',
};

const SANDBOX = 'com.usebottles.bottles';

// Native first, then Flatpak.
function bottleDirs() {
    return [
        dataDir('bottles', 'bottles'),
        sandboxDir(SANDBOX, 'data', 'bottles', 'bottles'),
    ];
}

const LAUNCHERS = new Set([
    'bottles-cli', 'bottles', '--command=bottles-cli', '--command=bottles', SANDBOX,
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

// bottle.yml -> {name, programs: [{name, stems, path, removed}]}; removed:
// hidden in Bottles' program list.
export function bottleFromConfig(config) {
    const programs = [];
    for (const program of Object.values(config.External_Programs ?? {})) {
        const exe = program?.executable || program?.path;
        if (program?.name && typeof exe === 'string') {
            // A shortcut (.lnk) is known by the program it starts, and by its
            // own name: Battle.net.lnk starts "Battle.net Launcher.exe",
            // which starts Battle.net.exe and quits.
            const runs = /\.lnk$/i.test(exe) && typeof program.path === 'string' ? programOf(program.path) : exe;
            programs.push({
                name: program.name,
                stems: [...new Set([exeStem(runs), exeStem(exe)])],
                path: canonical(program.path),
                removed: program.removed === 'true',
            });
        }
    }
    return {name: config.Name ?? null, programs};
}

export class BottlesSource extends LauncherSource {
    constructor() {
        super('bottles', {sandbox: SANDBOX, envKeys: ['BOTTLE']});
        this._configs = new StampCache(path => bottleFromConfig(parseYaml(readText(path))));
    }

    // -b is the bottle's folder name or path (native Bottles) or its Name
    // (Flatpak Bottles); windowKeys() tries all three.
    entryKeys(entry, argv, index) {
        const launch = parseBottlesExec(argv);
        if (!launch)
            return null;
        const ref = canonical(launch.bottle) ?? launch.bottle;
        const keys = launch.program ? [`${ref}\n${launch.program}`] : [];
        if (launch.executable) {
            const stem = exeStem(launch.executable);
            keys.push(`${ref}\nexe:${stem}`);
            index.add(index.exec, stem, entry.id);
        }
        return keys;
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
        if (argv.includes(SANDBOX))
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
            return exists(icon) ? icon : exeIcon(program.path);
        }
        return null;
    }

    // A bottle is a prefix only Bottles makes.
    launched(ctx) {
        return !!ctx.env.BOTTLE || !!this._bottle(ctx);
    }

    // For each program name: what the entry may call the bottle, then the
    // program by its name in the bottle or by its .exe.
    windowKeys(ctx) {
        const bottle = this._bottle(ctx);
        if (!bottle)
            return [];
        const refs = [bottle.dir, basename(bottle.dir), bottle.name].filter(Boolean);
        return ctx.stems.flatMap(stem => {
            const keys = [...bottle.programs.filter(p => p.stems.includes(stem)).map(p => p.name), `exe:${stem}`];
            return refs.flatMap(ref => keys.map(key => `${ref}\n${key}`));
        });
    }

    // A program added to Bottles but never given a desktop entry: Bottles
    // still extracted its icon from the .exe.
    fallback(ctx) {
        const bottle = this._bottle(ctx);
        const program = bottle?.programs.find(p => p.stems.some(stem => ctx.stems.includes(stem)));
        return program ? {icon: `${bottle.dir}/icons/${program.name}.png`, name: program.name} : null;
    }

    _bottle(ctx) {
        return this.remember(ctx, 'bottle', () => {
            const config = ctx.prefix && this._configs.get(`${ctx.prefix}/bottle.yml`);
            return config ? {dir: ctx.prefix, ...config} : null;
        });
    }
}
