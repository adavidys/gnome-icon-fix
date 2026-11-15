// Self-contained app bundles: an AppImage or a Snap carries the .desktop
// entry and the icons of the program inside it, as KDE reads them. When
// nothing on the host describes the program (an AppImage started straight
// from ~/Applications), its own entry still says what it is called and
// which icon it has.
//
// A bundle is found from the program's path, never from its environment
// alone: Electron and Chromium programs (most AppImages) write their
// process title over the environment, so /proc/<pid>/environ reads empty
// and APPIMAGE, APPDIR and SNAP are gone.
//
//   AppImage: the program runs from the image's mount (/tmp/.mount_XXXX),
//       whose root holds AppRun, the entry (*.desktop) and the icons
//       (usr/share/icons, <Icon>.png, .DirIcon). The image file itself is
//       APPIMAGE, else the program that serves that mount: the AppImage
//       runtime runs as the image file and names the mount after it.
//   Snap: /snap/<name>/<revision>/, entries in meta/gui/, where Icon= is
//       often ${SNAP}/meta/gui/icon.png.

import GLib from 'gi://GLib';

import {basename, cacheDir, canonical, exists, findHicolorIcon, isUnder, listDir, selfAndParents} from './util.js';

const decoder = new TextDecoder();
const ICON_EXTS = ['png', 'svg', 'xpm'];

// mount point or root -> what was read of it; a mount is gone (and its
// name never reused) once the program quits.
const known = new Map();
const MAX_KNOWN = 64;

// The keys of an entry Icon Fix uses, the name in the user's language.
export function parseEntry(path) {
    const file = new GLib.KeyFile();
    try {
        file.load_from_file(path, GLib.KeyFileFlags.NONE);
    } catch {
        return null;
    }
    const get = key => {
        try {
            return file.get_locale_string('Desktop Entry', key, null) || null;
        } catch {
            return null;
        }
    };
    if (get('Type') && get('Type') !== 'Application')
        return null;
    return {id: basename(path), name: get('Name'), icon: get('Icon'), wmClass: get('StartupWMClass'), exec: get('Exec')};
}

// The AppDir root a path lies in: the nearest folder above it with AppRun
// and an entry or a .DirIcon (the AppImage layout), or null.
export function appDirOf(path) {
    const dir = canonical(path);
    if (!dir)
        return null;
    for (const p of selfAndParents(dir.slice(0, dir.lastIndexOf('/')))) {
        if (exists(`${p}/AppRun`) && (exists(`${p}/.DirIcon`) || listDir(p).some(n => n.endsWith('.desktop'))))
            return p;
    }
    return null;
}

// /snap/<name>/<revision> above a path, or null.
export function snapDirOf(path) {
    return canonical(path)?.match(/^\/snap\/[^/]+\/[^/]+(?=\/)/)?.[0] ?? null;
}

// The mount's source (the image's file name, as the AppImage runtime names
// it) from a mountinfo text, or null.
export function mountSource(mountinfo, mountPoint) {
    for (const line of mountinfo.split('\n')) {
        // id parent dev root mountpoint options [optional...] - type source superoptions
        const fields = line.split(' ');
        const dash = fields.indexOf('-');
        if (dash > 4 && unescapeMount(fields[4]) === mountPoint)
            return unescapeMount(fields[dash + 2] ?? '') || null;
    }
    return null;
}

function unescapeMount(field) {
    return field.replace(/\\([0-7]{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// The AppImage file serving the mount a process runs from: the running
// program whose file is called like the mount's source, nearest to pid
// (each launch starts its own runtime right next to the program). null
// if there's none.
export function appImageServing(pid, root, procDir) {
    let source = null;
    try {
        source = mountSource(decoder.decode(GLib.file_get_contents(`${procDir}/${pid}/mountinfo`)[1]), root);
    } catch {}
    if (!source || !/\.appimage$/i.test(source))
        return null;
    let best = null;
    for (const name of listDir(procDir)) {
        if (!/^\d+$/.test(name))
            continue;
        let exe;
        try {
            exe = GLib.file_read_link(`${procDir}/${name}/exe`).replace(/ \(deleted\)$/, '');
        } catch {
            continue;
        }
        const distance = Math.abs(Number(name) - pid);
        if (basename(exe) === source && (!best || distance < best.distance))
            best = {exe, distance};
    }
    return best?.exe ?? null;
}

// An icon a bundle's entry names, as a path inside the bundle, or null.
// Icon= may be a path (${SNAP} standing for the bundle's root) or a name
// looked up in the bundle's own icon folders.
export function bundleIcon(root, icon, {shares = [], dirs = []} = {}) {
    if (icon?.includes('/')) {
        const path = canonical(icon.replace(/^\$\{?SNAP\}?/, root));
        return path && isUnder(path, root) && exists(path) ? path : null;
    }
    if (icon) {
        for (const share of shares) {
            const path = findHicolorIcon(share, icon);
            if (path)
                return path;
        }
        for (const dir of dirs) {
            const path = ICON_EXTS.map(ext => `${dir}/${icon}.${ext}`).find(exists);
            if (path)
                return path;
        }
    }
    return exists(`${root}/.DirIcon`) ? `${root}/.DirIcon` : null;
}

// Copies a bundle's icon out of it: an AppImage's mount goes away when
// the program quits, while GNOME may still draw its icon. Named after its
// content, so every launch reuses the same file. null if it can't be read.
export function keepIcon(path) {
    let bytes;
    try {
        bytes = GLib.file_get_contents(path)[1];
    } catch {
        return null;
    }
    // .DirIcon has no extension: an SVG is told by its first bytes.
    const ext = /^\s*(<\?xml|<svg)/.test(decoder.decode(bytes.slice(0, 64))) ? 'svg' : 'png';
    const dir = cacheDir('bundle-icons');
    const out = `${dir}/${GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes)}.${ext}`;
    if (!exists(out)) {
        try {
            GLib.mkdir_with_parents(dir, 0o755);
            GLib.file_set_contents(out, bytes);
        } catch {
            return null;
        }
    }
    return out;
}

// What a bundle says about itself: its entry (the one whose name or icon
// fits the program, else the first) and that entry's icon, kept outside it.
function readBundle(root, layout, program) {
    const entries = layout.entryDirs.flatMap(dir => listDir(dir).filter(n => n.endsWith('.desktop'))
        .map(n => parseEntry(`${dir}/${n}`))).filter(Boolean);
    const stem = basename(program ?? '').toLowerCase();
    const entry = entries.find(e => [e.id.replace(/\.desktop$/, ''), e.icon, e.wmClass]
        .some(k => k?.toLowerCase() === stem)) ?? entries[0] ?? null;
    const icon = bundleIcon(root, entry?.icon, layout);
    return {root, kind: layout.kind, entry, icon: icon ? keepIcon(icon) : null};
}

const LAYOUTS = {
    appimage: root => ({kind: 'appimage', entryDirs: [root],
        shares: [`${root}/usr/share`, `${root}/share`], dirs: [root, `${root}/usr/share/pixmaps`]}),
    snap: root => ({kind: 'snap', entryDirs: [`${root}/meta/gui`],
        shares: [`${root}/usr/share`, `${root}/meta/gui`], dirs: [`${root}/meta/gui`, `${root}/usr/share/pixmaps`]}),
};

// The bundle a process runs from: {kind, root, file, entry, icon}, or
// null. file: the AppImage file (null for a Snap); entry: see parseEntry().
// proc: from readProcess(); procDir: where /proc is.
export function bundleOf(proc, procDir = '/proc') {
    const programs = [proc.exe, proc.argv[0]].filter(Boolean);
    let root = null;
    let kind = null;
    for (const path of programs) {
        root = snapDirOf(path);
        kind = root && 'snap';
        if (!root) {
            root = appDirOf(path);
            kind = root && 'appimage';
        }
        if (root)
            break;
    }
    if (!root && proc.env.APPDIR && appDirOf(`${proc.env.APPDIR}/AppRun`)) {
        root = canonical(proc.env.APPDIR);
        kind = 'appimage';
    }
    if (!root)
        return null;

    let found = known.get(root);
    if (!found) {
        found = readBundle(root, LAYOUTS[kind](root), proc.exe);
        // A mount is one launch of one image: whoever serves it now does.
        found.file = kind === 'appimage' ? canonical(proc.env.APPIMAGE) ?? appImageServing(proc.pid, root, procDir) : null;
        if (known.size >= MAX_KNOWN)
            known.delete(known.keys().next().value);
        known.set(root, found);
    }
    return found;
}

// Forgets what was read (tests, and the extension when disabled).
export function forgetBundles() {
    known.clear();
}
