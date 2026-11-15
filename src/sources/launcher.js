// Game launchers, all handled the same way. What tells one launcher from
// another is data (src/launchers.js): where it keeps its files, how its
// shortcuts name a game, and how a running game names itself. Everything
// done with that is here, once for every launcher:
//
//   - A shortcut's Exec= (or id, or Icon=) gives fields: {id: '70'} for
//     steam://rungameid/70, {bottle, program} for bottles-cli run -p -b...
//   - A launcher's files give game records: {fields, name, dir, prefix,
//     exe, icon}. A record's fields are lists: a bottle is known by its
//     folder, its path and its name alike.
//   - A running game gives fields too (its environment, its window class,
//     its Wine prefix), and the record they point at, or the one whose
//     prefix it runs in, or whose folder it runs from, adds its own.
//   - The shortcut whose every field the window has is the game's; one of
//     the window's own flavor (native or the launcher's Flatpak) first.
//
// The keys of a description are listed in launchers.js.

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {NATIVE, flavorOf} from '../lib/appindex.js';
import {parseBinaryVdf, parseVdf, parseYaml} from '../lib/formats.js';
import {guessPaths} from '../lib/matcher.js';
import {exeIcon} from '../lib/peicon.js';
import {programFromArgv} from '../lib/process.js';
import {
    StampCache, basename, canonical, dataDir, exeStem, exists, findHicolorIcon, findSandboxedIcon, isSpecificDir, isUnder,
    listDir, pathKey, readJson, readText,
} from '../lib/util.js';

const READERS = {
    json: readJson,
    yaml: path => parseYaml(readText(path) ?? ''),
    vdf: path => parseVdf(readText(path) ?? ''),
    binvdf: path => parseBinaryVdf(GLib.file_get_contents(path)[1]),
};

// Proton and umu keep the prefix in <compat data>/pfx and say where the
// compat data is: either path is the game's prefix.
const PREFIX_VARS = ['STEAM_COMPAT_DATA_PATH'];

// How far from square a picture may be and still be an icon: launchers
// save covers (tall) and banners (wide) where icons go too.
const ICON_RATIO = 0.25;

// "steam_icon_{id}" with {id: ['70']} -> "steam_icon_70"; null when a
// field is missing.
export function fillTemplate(template, fields) {
    if (!template)
        return null;
    let missing = false;
    const out = template.replace(/\{(\w+)\}/g, (_m, key) => {
        const value = [fields[key] ?? []].flat()[0];
        missing ||= value === undefined;
        return value ?? '';
    });
    return missing ? null : out;
}

// Whether an image is roughly square (an icon, not a cover).
export function iconShaped(path) {
    const info = GdkPixbuf.Pixbuf.get_file_info(path);
    return !!info[0] && Math.abs(Math.log(info[1] / info[2])) < ICON_RATIO;
}

// Option-style launch lines: `cmd [args] -p X --bottle=Y` -> {program: X,
// bottle: Y}, read after the first argument that is one of commands.
// null if there's none.
export function parseOptions(argv, {commands, flags}) {
    const at = argv.findIndex(a => commands.includes(a) || commands.includes(basename(a)));
    if (at < 0)
        return null;
    const out = {};
    for (let i = at + 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--')
            break;
        const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
        const key = flags[eq > 0 ? arg.slice(0, eq) : arg];
        if (key)
            out[key] = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    }
    return out;
}

// The groups a regex matched, without the ones that didn't take part.
// (No destructuring in these loops: gjs counts a branch for each.)
export function groups(match) {
    const out = {};
    for (const key in match?.groups ?? {}) {
        if (match.groups[key] !== undefined)
            out[key] = match.groups[key];
    }
    return out;
}

// {a: 'x', b: ['y', 'z']} -> Map a -> ['x'], b -> ['y', 'z'], empty ones left out
export function asLists(fields) {
    const lists = new Map();
    for (const key in fields) {
        const values = [fields[key]].flat().filter(v => typeof v === 'string' && v);
        if (values.length)
            lists.set(key, values);
    }
    return lists;
}

// How well fields (a shortcut's, one value each) fit what is known (field
// -> values, best first): the worst position any of them is found at, or
// -1 if one isn't there. Fields saying nothing fit nothing.
export function fit(fields, known) {
    let worst = -1;
    const lists = asLists(fields);
    for (const key of lists.keys()) {
        const at = known.get(key)?.indexOf(lists.get(key)[0]) ?? -1;
        if (at < 0)
            return -1;
        worst = Math.max(worst, at);
    }
    return worst;
}

// Where a launcher file lies: inside a Flatpak app's data, or the host's.
export function flavorOfPath(path) {
    return path.match(/\/\.var\/app\/([^/]+)\//)?.[1].toLowerCase() ?? NATIVE;
}

// What runs a launch line: the Flatpak app id of `flatpak run`, or native.
function flavorOfArgv(argv) {
    return programFromArgv(argv)?.flatpak ?? NATIVE;
}

export class LauncherSource {
    constructor(desc) {
        this.desc = desc;
        this.name = desc.name;
        this.sandbox = desc.sandbox ?? null;
        this.envKeys = [...new Set([
            ...PREFIX_VARS,
            ...(desc.window ?? []).map(s => s.env),
            ...(desc.launchedBy ?? []).flatMap(l => [l.env, l.unless]),
            desc.nameEnv,
        ].filter(Boolean))];
        // file -> its records; folder -> its files; file -> the spec reading it
        this._files = new StampCache(path => this._read(path));
        this._specs = new Map();
        this._lists = new StampCache(dir => listDir(dir));
    }

    // --- Its games

    // Every file of its library there is now.
    _paths() {
        return this.desc.library.flatMap(spec => {
            const paths = spec.files ? spec.files(this)
                : spec.dirs(this).flatMap(dir => (this._lists.get(dir) ?? [])
                    .filter(n => spec.match.test(n)).map(n => `${dir}/${n}`));
            for (const path of paths)
                this._specs.set(path, spec);
            return paths;
        });
    }

    _read(path) {
        const spec = this._specs.get(path);
        const doc = READERS[spec.format](path);
        const flavor = flavorOfPath(path);
        return [spec.records(doc, path, this) ?? []].flat().filter(Boolean)
            .map(record => this._record(record, flavor));
    }

    // A record as read, filled in: lists for fields, its program's name as
    // the exe field, paths made comparable.
    _record(record, flavor) {
        const exe = canonical(record.exe);
        const stems = [...new Set([...record.stems ?? [], exe && exeStem(exe)].filter(Boolean))];
        const fields = Object.fromEntries(asLists(record.fields ?? {}));
        if (stems.length)
            fields.exe = [...new Set([...fields.exe ?? [], ...stems])];
        const dir = canonical(record.dir) ?? (exe ? GLib.path_get_dirname(exe) : null);
        const prefix = canonical(record.prefix);
        return {
            ...record,
            flavor,
            fields,
            stems,
            exe,
            dir: dir && isSpecificDir(dir) ? pathKey(dir) : null,
            prefix: prefix ? pathKey(prefix) : null,
        };
    }

    // Its games, those of flavor first (native or its Flatpak: both may
    // know the same game). The records of one game (desc.key) read from
    // several files are merged, the first file's first.
    records(flavor = NATIVE) {
        const key = this.desc.key;
        const merged = [];
        const byKey = new Map();
        for (const path of this._paths()) {
            for (const record of this._files.get(path) ?? []) {
                const id = key && record.fields[key] ? `${record.flavor}\0${record.fields[key][0]}` : null;
                const same = id ? byKey.get(id) : null;
                if (!same) {
                    const copy = {...record, fields: {...record.fields}};
                    merged.push(copy);
                    if (id)
                        byKey.set(id, copy);
                    continue;
                }
                for (const k in record) {
                    if (same[k] === null || same[k] === undefined)
                        same[k] = record[k];
                }
                for (const k in record.fields)
                    same.fields[k] = [...new Set([...same.fields[k] ?? [], ...record.fields[k]])];
                same.stems = same.fields.exe ?? [];
            }
        }
        const own = flavor.toLowerCase();
        return [...merged.filter(r => r.flavor === own), ...merged.filter(r => r.flavor !== own)];
    }

    // --- Shortcuts

    // The fields of a shortcut, or null if it doesn't run this launcher.
    // raw: as written, not as its games know them (normalize).
    shortcutFields(entry, argv, raw = false) {
        const spec = this.desc.shortcut;
        let fields = null;
        for (const re of [spec.exec ?? []].flat()) {
            const m = entry.exec?.match(re);
            if (m) {
                fields = groups(m);
                break;
            }
        }
        if (!fields && spec.options)
            fields = parseOptions(argv, spec.options);
        if (!fields)
            return null;
        for (const {from, re} of spec.also ?? [])
            fields = {...groups(entry[from]?.match(re)), ...fields};
        return spec.normalize && !raw ? spec.normalize(fields) : fields;
    }

    // Fields of an entry that doesn't run this launcher but names one of
    // its games (by its icon).
    _hintFields(entry) {
        for (const {from, re} of this.desc.shortcut.hint ?? []) {
            const m = entry[from]?.match(re);
            if (m)
                return groups(m);
        }
        return null;
    }

    indexEntry(entry, argv, index) {
        const fields = this.shortcutFields(entry, argv);
        const shown = fields ?? this._hintFields(entry);
        if (shown && asLists(shown).size)
            index.map(this.name).set(entry.id, {fields: shown, flavor: index.flavor.get(entry.id)});
        return !!fields;
    }

    // --- A running game

    // What the window's process says about its game by itself:
    // [[field, value]], strongest first.
    signals(ctx) {
        return this.remember(ctx, 'signals', () => (this.desc.window ?? []).flatMap(signal => {
            const value = signal.env ? ctx.env[signal.env] : signal.class ? ctx.wmClass : ctx.prefix;
            if (!value)
                return [];
            return signal.re ? Object.entries(groups(value.match(signal.re))) : [[signal.field, value]];
        }));
    }

    // The Wine prefixes the window's process runs in, each also without
    // the /pfx Proton and umu keep the actual prefix in (pathKey'd).
    prefixes(ctx) {
        return this.remember(ctx, 'prefixes', () => [...new Set(
            [ctx.prefix, ...PREFIX_VARS.map(v => canonical(ctx.env[v]))].filter(Boolean)
                .flatMap(p => p.endsWith('/pfx') ? [p, p.slice(0, -4)] : [p]).map(pathKey))]);
    }

    // What it worked out about a window, kept on the window's context.
    remember(ctx, key, find) {
        const slot = `${this.name}:${key}`;
        if (ctx[slot] === undefined)
            ctx[slot] = find();
        return ctx[slot];
    }

    // The game record of a window: the one its signals name, else the one
    // whose prefix it runs in, else the one whose folder it runs from (a
    // guess: not when another launcher started it). null if none.
    game(ctx) {
        return this.remember(ctx, 'game', () => {
            const records = this.records(flavorOf(ctx));
            const signals = this.signals(ctx);
            for (const signal of signals) {
                const named = records.filter(r => r.fields[signal[0]]?.includes(signal[1]));
                if (named.length)
                    return this._pick(ctx, named) ?? named[0];
            }
            // A game it names but doesn't list: not another one by a guess.
            if (signals.length)
                return null;
            const prefixes = this.prefixes(ctx);
            const inPrefix = records.filter(r => r.prefix && prefixes.includes(r.prefix));
            return inPrefix.length ? this._pick(ctx, inPrefix) : this._inFolder(ctx, records);
        });
    }

    // One of several records that may be the window's (the games sharing
    // a prefix, a bottle and its programs): the one running its program,
    // else the one whose folder it runs from, else the one all the others
    // belong to (the bottle itself: each program has its fields too). A
    // single one is it.
    _pick(ctx, records) {
        if (records.length === 1)
            return records[0];
        const within = (inner, outer) => Object.keys(inner.fields).every(k =>
            inner.fields[k].every(v => outer.fields[k]?.includes(v)));
        const found = records.find(r => r.stems.some(s => ctx.stems.includes(s))) ?? this._inFolder(ctx, records) ??
            records.find(r => records.every(other => within(r, other)));
        return found ?? null;
    }

    _inFolder(ctx, records) {
        const where = guessPaths(ctx, this);
        return records.find(r => r.dir && where.some(path => isUnder(path, r.dir))) ?? null;
    }

    // Everything known of the window's game: field -> values, best first
    // (its signals, then its record's), and its program's names.
    _known(ctx) {
        return this.remember(ctx, 'known', () => {
            const known = new Map();
            const add = (key, values) => known.set(key, [...new Set([...known.get(key) ?? [], ...values])]);
            for (const signal of this.signals(ctx))
                add(signal[0], [signal[1]]);
            const game = this.game(ctx);
            for (const key in game?.fields ?? {})
                add(key, game.fields[key]);
            add('exe', ctx.stems);
            return known;
        });
    }

    // Whether it started the window's process: a variable only it sets, or
    // a prefix it made for one of its games.
    launched(ctx) {
        const byEnv = (this.desc.launchedBy ?? []).some(l => {
            const value = ctx.env[l.env];
            return !!value && (!l.re || l.re.test(value)) && !(l.unless && ctx.env[l.unless]);
        });
        const prefixes = this.prefixes(ctx);
        return byEnv || (prefixes.length > 0 && this.records().some(r => r.prefix && prefixes.includes(r.prefix)));
    }

    // Its shortcut for the window's game: every field of it known about the
    // window; one of the window's own flavor first, then the best fitting.
    identify(ctx, index) {
        const known = this._known(ctx);
        const own = flavorOf(ctx);
        let best = null;
        const shortcuts = index.map(this.name);
        for (const id of shortcuts.keys()) {
            const shortcut = shortcuts.get(id);
            const at = fit(shortcut.fields, known);
            const rank = (shortcut.flavor === own ? 0 : 1e6) + at;
            if (at >= 0 && (!best || rank < best.rank))
                best = {id, rank};
        }
        return best ? {id: best.id} : null;
    }

    // What it knows of a game it has no shortcut for: its name and icon.
    fallback(ctx) {
        const game = this.game(ctx);
        const fields = game?.fields ?? Object.fromEntries(this.signals(ctx).map(signal => [signal[0], [signal[1]]]));
        const name = (this.desc.nameEnv && ctx.env[this.desc.nameEnv]) || game?.name || null;
        const iconName = fillTemplate(this.desc.iconName, fields);
        const icon = game || iconName ? this.iconOf(game, fields, {windows: ctx.wine}) : null;
        if (!icon && !name && !iconName)
            return null;
        return {...iconName ? {iconName} : {}, icon, name};
    }

    // An icon file for a shortcut of its whose own icon can't be shown.
    entryIcon(entry, argv) {
        const fields = this.shortcutFields(entry, argv);
        if (!fields || !asLists(fields).size)
            return null;
        const game = this.recordOf(fields, flavorOfArgv(argv));
        return this.iconOf(game, game?.fields ?? fields);
    }

    // The game record a shortcut's fields name, of flavor first.
    recordOf(fields, flavor) {
        return this.records(flavor).find(r => fit(fields, asLists(r.fields)) >= 0) ?? null;
    }

    // The best icon file for a game (its record, or just its fields), or
    // null, in this order:
    //   its own icon, if it is one (not a cover);
    //   the icon its shortcuts name, wherever the launcher put it;
    //   the icon of its program (dir: where to save that);
    //   a picture of it that isn't an icon, or the small icon the launcher
    //   keeps for every game: not for a Windows program (windows), whose
    //   .exe has a better one.
    iconOf(game, fields, {windows = false, dir} = {}) {
        const own = game?.icon && exists(game.icon) ? game.icon : null;
        if (own && iconShaped(own))
            return own;
        const named = fillTemplate(this.desc.iconName, fields);
        const themed = named &&
            (findHicolorIcon(dataDir(), named) ?? findSandboxedIcon(named, this.sandbox ? [this.sandbox] : []));
        if (themed)
            return themed;
        const program = game?.exe ? exeIcon(game.exe, dir) : null;
        if (program || windows)
            return program;
        return own ?? this.desc.extraIcon?.(fields, this) ?? null;
    }
}
