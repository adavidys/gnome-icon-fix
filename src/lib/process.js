// What /proc tells us about the process behind a window, and how to turn
// the Windows paths a Wine process shows into host paths.

import GLib from 'gi://GLib';

import {basename, canonical, home} from './util.js';

const decoder = new TextDecoder();

// Launchers and interpreters: their names say nothing about which app runs.
export const GENERIC_BINARIES = new Set([
    'env', 'sh', 'bash', 'zsh', 'fish', 'dash', 'python', 'python3', 'perl',
    'java', 'mono', 'node', 'electron', 'flatpak', 'snap', 'xdg-open',
    'gtk-launch', 'steam', 'wine', 'wine64', 'wine-preloader',
    'wine64-preloader', 'wineserver', 'proton', 'umu-run', 'lutris', 'heroic',
    'bottles', 'bottles-cli', 'gamemoderun', 'gamescope', 'prime-run',
    'mangohud', 'pressure-vessel-wrap', 'reaper', 'steam-runtime-launcher-service',
    'start.exe', 'explorer.exe', 'steam.exe', 'pv-adverb', 'srt-bwrap', 'bwrap',
    'obs-gamecapture', 'strangle', 'firejail', 'nice', 'taskset', 'systemd-run',
]);

const SEPARATED_WRAPPERS = new Set(['gamescope']);

const WINE_LOADER = /^wine(?:64)?(?:-preloader)?$/;

// The program an argv runs, skipping launchers, wrappers and their options:
// {path} (for Wine, the .exe), {flatpak: appId}, or null.
export function programFromArgv(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg || arg.startsWith('-') || arg.includes('://') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg))
            continue;
        const base = basename(arg).toLowerCase();
        if (base === 'flatpak' && argv[i + 1] === 'run') {
            const appId = argv.slice(i + 2).find(a => !a.startsWith('-'));
            return appId ? {flatpak: appId.toLowerCase()} : null;
        }
        const afterWine = i > 0 && isWineBinary(argv[i - 1]);
        if (base === 'start.exe' || (base === 'start' && afterWine)) {
            // `wine start [/unix|/wait|...] <file>`
            while (/^\/[a-z]+$/i.test(argv[i + 1] ?? ''))
                i++;
            continue;
        }
        if (GENERIC_BINARIES.has(base)) {
            // gamescope takes values ("-w 1920 -b sdl") and puts the real
            // command after "--".
            const sep = SEPARATED_WRAPPERS.has(base) ? argv.indexOf('--', i + 1) : -1;
            if (sep > i)
                i = sep;
            continue;
        }
        if (/^\d+$/.test(arg))
            continue;
        return {path: arg};
    }
    return null;
}

export function isWineBinary(path) {
    return WINE_LOADER.test(basename(path).toLowerCase());
}

export function isWineProcess(proc) {
    return isWineBinary(proc.exe ?? '') ||
        /\.exe$/i.test(proc.argv[0] ?? '');
}

// Wine shows programs as "C:\...\game.exe" or "Z:\home\...\game.exe". Z: is
// the host root; other drives are links in the prefix's dosdevices.
export function wineToHost(path, prefix) {
    const m = path.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!m)
        return canonical(path);
    const rest = m[2].replace(/\\/g, '/');
    const drive = m[1].toLowerCase();
    if (drive === 'z')
        return canonical(`/${rest}`);
    if (!prefix)
        return null;
    const link = `${prefix}/dosdevices/${drive}:`;
    let target;
    try {
        target = GLib.file_read_link(link);
    } catch {
        return null;
    }
    return canonical(target.startsWith('/') ? `${target}/${rest}` : `${prefix}/dosdevices/${target}/${rest}`);
}

// envKeys: the environment variables to keep (all of a Proton game's
// environment is tens of kilobytes; the sources need a handful).
export function readProcess(pid, envKeys) {
    const info = {pid, argv: [], exe: null, cwd: null, env: {}};
    if (!pid || pid <= 0)
        return info;

    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        info.argv = decoder.decode(bytes).split('\0').filter(Boolean);
    } catch {}

    for (const link of ['exe', 'cwd']) {
        try {
            info[link] = GLib.file_read_link(`/proc/${pid}/${link}`).replace(/ \(deleted\)$/, '');
        } catch {}
    }

    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/environ`);
        for (const kv of decoder.decode(bytes).split('\0')) {
            const eq = kv.indexOf('=');
            if (eq > 0 && envKeys.has(kv.slice(0, eq)))
                info.env[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
    } catch {}

    return info;
}

// The Wine prefix a process runs in: WINEPREFIX, or Wine's default.
export function winePrefixOf(proc, wine) {
    return canonical(proc.env.WINEPREFIX) ?? (wine ? home('.wine') : null);
}
