// Finds the .desktop entry for a window GNOME could not match by itself,
// KDE-style: first the sources' exact signals (Steam app ids, Wine prefixes,
// launcher configs...), then window class, program and install folder, then
// the window title. When nothing matches, a source may still know an icon.
//
// The title is matched separately (matchTitle) because it can change at
// frame rate (FPS counters) while everything else stays the same.

import {tryCall} from './appindex.js';
import {GENERIC_BINARIES, isWineProcess, mappedProgram, programFromArgv, winePrefixOf, wineToHost} from './process.js';
import {basename, canonical, exeStem, normalize, pathKey} from './util.js';

const NO_PROCESS = {pid: 0, argv: [], exe: null, cwd: null, env: {}};

// What the sources get to see about a window, worked out once:
//   wmClass, wmInstance, gtkId, sandboxId: from the window
//   launcherSandbox: the Flatpak sandbox it runs in, also when sandboxId
//          is left out to match it as if it weren't sandboxed
//   launcher: name of the source whose launcher started it, or null
//   proc, env: from readProcess()
//   wine: whether it's a Wine process; prefix: its Wine prefix
//   stems: lowercased program names without extension ("game" for
//          C:\Games\Game.exe, and the window class for Wine)
//   paths: host paths of the program (for Wine, first the .exe it has
//          mapped, see mappedProgram()); cwd: its working folder
// Sources may add their own fields to share work between their calls.
export function windowContext(hints) {
    const proc = hints.proc ?? NO_PROCESS;
    const wine = isWineProcess(proc);
    const prefix = winePrefixOf(proc, wine);
    const stems = new Set();
    const paths = new Set();

    const addProgram = path => {
        stems.add(exeStem(path));
        const host = wine ? wineToHost(path, prefix) : canonical(path);
        if (host)
            paths.add(host);
    };
    const program = programFromArgv(proc.argv);
    // The .exe a Wine process really runs, wherever its drive letter points.
    const mapped = wine && program?.path ? mappedProgram(proc.pid, program.path) : null;
    if (mapped)
        paths.add(mapped);
    if (program?.flatpak)
        stems.add(program.flatpak);
    else if (program?.path)
        addProgram(program.path);
    if (proc.exe && !GENERIC_BINARIES.has(basename(proc.exe).toLowerCase()))
        addProgram(proc.exe);
    // Wine names its windows after the .exe.
    if (wine) {
        for (const cls of [hints.wmClass, hints.wmInstance].filter(Boolean))
            stems.add(exeStem(cls));
    }
    stems.delete('');

    return {
        wmClass: hints.wmClass ?? null,
        wmInstance: hints.wmInstance ?? null,
        gtkId: hints.gtkId ?? null,
        sandboxId: hints.sandboxId ?? null,
        launcherSandbox: hints.launcherSandbox ?? hints.sandboxId ?? null,
        launcher: null,
        proc,
        env: proc.env,
        wine,
        prefix,
        stems: [...stems],
        paths: [...paths],
        cwd: canonical(proc.cwd),
    };
}

// Where the program runs from (pathKey'd), for a source to guess its game
// by folder; nothing when another launcher started it, as one game folder
// may be added to several launchers.
export function guessPaths(ctx, source) {
    if (ctx.launcher && ctx.launcher !== source.name)
        return [];
    return [...ctx.paths, ctx.cwd].filter(Boolean).map(pathKey);
}

function identify(index, sources, ctx) {
    for (const source of sources) {
        const found = tryCall(source, 'identify', ctx, index);
        if (found)
            return {...found, by: source.name};
    }

    // A guess must not hand a game one launcher started to another
    // launcher's shortcut for the same game (same name, same folder), nor a
    // native program to a Wine menu entry with the same program name.
    const fits = id => {
        const owner = index.owner.get(id);
        return !!id && (ctx.wine || owner !== 'wine') && (!ctx.launcher || (owner ?? ctx.launcher) === ctx.launcher);
    };

    const keys = {'sandbox id': ctx.sandboxId, 'GTK app id': ctx.gtkId,
        'window class': ctx.wmClass, 'window instance': ctx.wmInstance};
    for (const by in keys) {
        const id = index.lookup(keys[by]);
        if (fits(id))
            return {id, by};
    }

    const exact = index.exactPath(ctx.paths);
    if (fits(exact))
        return {id: exact, by: 'program path'};

    for (const stem of ctx.stems) {
        const id = index.lookup(stem);
        if (fits(id))
            return {id, by: 'program name'};
    }

    const near = index.nearestDir(ctx.cwd ? [...ctx.paths, ctx.cwd] : ctx.paths);
    return fits(near) ? {id: near, by: 'install folder'} : null;
}

// hints: {wmClass, wmInstance, gtkId, sandboxId, launcherSandbox, proc}
// Returns {primary, fallbacks}: primary is {id} of a desktop entry or null;
// fallbacks (only looked for without a primary) are what the sources would
// show instead, best first: [{iconName?, icon?, name?, source}]. primary.by
// says what found it (a source's name, or the kind of guess).
// all: also look for fallbacks when there is a primary (the Debug tab
// shows what else could have been used).
export function matchWindow(index, sources, hints, all = false) {
    const ctx = windowContext(hints);
    ctx.launcher = sources.find(s =>
        (s.sandbox && s.sandbox === ctx.launcherSandbox) || tryCall(s, 'launched', ctx))?.name ?? null;
    const primary = identify(index, sources, ctx);
    if (primary && !all)
        return {primary, fallbacks: []};
    return {
        primary,
        fallbacks: sources.flatMap(s => {
            const found = tryCall(s, 'fallback', ctx, index);
            return found ? [{...found, source: s.name}] : [];
        }),
    };
}

export function matchTitle(index, title) {
    const id = index.name.get(normalize(title));
    return id ? {id} : null;
}
