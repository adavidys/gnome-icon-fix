// Heuristics for finding the .desktop entry that belongs to a window GNOME
// could not match by itself. Kept free of Shell/St imports so it can be
// tested with plain gjs.

import GLib from 'gi://GLib';

// Launchers and interpreters: their names say nothing about which app runs.
const GENERIC_BINARIES = new Set([
    'env', 'sh', 'bash', 'zsh', 'fish', 'dash', 'python', 'python3', 'perl',
    'java', 'mono', 'node', 'electron', 'flatpak', 'snap', 'xdg-open',
    'gtk-launch', 'steam', 'wine', 'wine64', 'wine-preloader',
    'wine64-preloader', 'wineserver', 'proton', 'umu-run', 'lutris', 'heroic',
    'bottles', 'bottles-cli', 'gamemoderun', 'gamescope', 'prime-run',
    'mangohud', 'pressure-vessel-wrap', 'reaper', 'steam-runtime-launcher-service',
    'start.exe', 'explorer.exe', 'steam.exe', 'pv-adverb', 'srt-bwrap', 'bwrap',
]);

const decoder = new TextDecoder();

export function normalize(str) {
    if (!str)
        return '';
    return str.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function stripExt(name) {
    return name.replace(/\.(exe|sh|py|appimage|x86_64|x86|bin|run|desktop)$/i, '');
}

function basename(path) {
    return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
}

// Returns the binary names worth matching on for an argv.
function binariesFromArgv(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg || arg.startsWith('-') || arg.includes('://') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg))
            continue;
        const base = basename(arg).toLowerCase();
        if (base === 'flatpak' && argv[i + 1] === 'run') {
            const appId = argv.slice(i + 2).find(a => !a.startsWith('-'));
            if (appId)
                out.push(appId.toLowerCase());
            break;
        }
        if (GENERIC_BINARIES.has(base))
            continue;
        // First non-launcher argument is the real program (for Wine: the .exe).
        out.push(stripExt(base));
        break;
    }
    return out;
}

function addKey(map, key, id) {
    if (key && !map.has(key))
        map.set(key, id);
}

export class AppIndex {
    // entries: [{id, name, wmClass, exec, icon}] (strings, may be null)
    constructor(entries) {
        this.wmClass = new Map();
        this.id = new Map();
        this.exec = new Map();
        this.icon = new Map();
        this.name = new Map();
        this.steam = new Map();

        for (const e of entries) {
            const id = e.id;
            const shortId = id.replace(/\.desktop$/, '').toLowerCase();
            addKey(this.id, shortId, id);
            addKey(this.id, shortId.split('.').pop(), id);
            addKey(this.wmClass, e.wmClass?.toLowerCase(), id);
            addKey(this.name, normalize(e.name), id);

            if (e.icon && !e.icon.startsWith('/'))
                addKey(this.icon, e.icon.toLowerCase(), id);

            const steamIcon = e.icon?.match(/^steam_icon_(\d+)$/);
            if (steamIcon)
                addKey(this.steam, steamIcon[1], id);

            if (e.exec) {
                const steamRun = e.exec.match(/steam:\/\/(?:rungameid|run)\/(\d+)/);
                if (steamRun) {
                    addKey(this.steam, steamRun[1], id);
                    // Non-Steam shortcuts launch by a 64-bit game id whose
                    // upper half is the app id used in steam_app_<id>.
                    const gameId = BigInt(steamRun[1]);
                    if (gameId > 0xffffffffn)
                        addKey(this.steam, String(gameId >> 32n), id);
                }

                let argv = [];
                try {
                    argv = GLib.shell_parse_argv(e.exec.replace(/%[a-zA-Z]/g, ''))[1];
                } catch {}
                for (const bin of binariesFromArgv(argv))
                    addKey(this.exec, bin, id);
            }
        }
    }

    // Looks a raw string (wm class, binary...) up in every map, strongest first.
    lookup(raw) {
        if (!raw)
            return null;
        const lower = stripExt(raw.toLowerCase());
        return this.wmClass.get(lower) ??
            this.id.get(lower) ??
            this.exec.get(lower) ??
            this.icon.get(lower) ??
            this.name.get(normalize(lower)) ??
            null;
    }
}

// Reads what /proc knows about a process: argv, exe and Steam ids.
export function readProcess(pid) {
    const info = {argv: [], exe: null, steamIds: []};
    if (!pid || pid <= 0)
        return info;

    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        info.argv = decoder.decode(bytes).split('\0').filter(Boolean);
    } catch {}

    try {
        info.exe = GLib.file_read_link(`/proc/${pid}/exe`);
    } catch {}

    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/environ`);
        const env = {};
        for (const kv of decoder.decode(bytes).split('\0')) {
            const eq = kv.indexOf('=');
            if (eq > 0)
                env[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        info.steamIds = [env.SteamAppId, env.SteamGameId]
            .filter(id => id && id !== '0');
    } catch {}

    return info;
}

// hints: {wmClass, wmInstance, gtkId, sandboxId, title, proc}
// Returns {id} for a desktop entry, {steamId} when only a Steam icon is
// known, or null.
export function match(index, hints) {
    const steamIds = [hints.wmClass?.match(/^steam_app_(\d+)$/i)?.[1], ...hints.proc?.steamIds ?? []]
        .filter(Boolean);
    for (const steamId of steamIds) {
        if (index.steam.has(steamId))
            return {id: index.steam.get(steamId)};
    }

    for (const key of [hints.sandboxId, hints.gtkId, hints.wmClass, hints.wmInstance]) {
        const id = index.lookup(key);
        if (id)
            return {id};
    }

    const proc = hints.proc;
    if (proc) {
        const bins = binariesFromArgv(proc.argv);
        if (proc.exe && !GENERIC_BINARIES.has(basename(proc.exe).toLowerCase()))
            bins.push(stripExt(basename(proc.exe).toLowerCase()));
        for (const bin of bins) {
            const id = index.lookup(bin);
            if (id)
                return {id};
        }
    }

    const byTitle = index.name.get(normalize(hints.title));
    if (byTitle)
        return {id: byTitle};

    if (steamIds.length)
        return {steamId: steamIds[0]};

    return null;
}
