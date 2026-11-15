// App packaging formats. Flatpak needs nothing here: Mutter reports a
// window's sandboxed app id and the matcher looks it up directly.
//
// Snap: entries are <snap>_<app>.desktop and the process has SNAP_NAME, or
// runs from /snap/<name>/.
// AppImage: the program runs from the image's mount, and the entry
// (AppImageLauncher, Gear Lever...) launches the image file, or a script
// the entry runs does (packages put a wrapper in /usr/bin: osu-lazer runs
// /opt/osu-lazer/osu.AppImage).
// Either way, without an entry on the host the bundle's own one says what
// the program is called and which icon it has (lib/bundle.js).

import GLib from 'gi://GLib';

import {bundleOf} from '../lib/bundle.js';
import {StampCache, canonical, exeStem, fileId} from '../lib/util.js';

// A wrapper script is small; anything bigger is a program.
const MAX_SCRIPT = 16 * 1024;

export class PackagingSource {
    constructor() {
        this.name = 'packaging';
        this.envKeys = ['SNAP_INSTANCE_NAME', 'SNAP_NAME', 'APPIMAGE', 'APPDIR'];
        // program -> the AppImages it runs if it is a script (#!), else []
        this._scripts = new StampCache(path => {
            const bytes = GLib.file_get_contents(path)[1];
            if (bytes.length > MAX_SCRIPT || bytes[0] !== 0x23 || bytes[1] !== 0x21)
                return [];
            return new TextDecoder().decode(bytes).match(/\/[^\s"'`;|&<>]+\.appimage\b/gi) ?? [];
        });
    }

    indexEntry(entry, _argv, index) {
        const snap = entry.id.match(/^([a-z0-9][a-z0-9-]*)_[\w-]+\.desktop$/)?.[1];
        if (snap && entry.exec?.includes('/snap/bin/'))
            index.add(index.map('snap'), snap, entry.id);
        return false;
    }

    // What the window's process runs from, read once per window.
    _bundle(ctx) {
        if (ctx.bundle === undefined)
            ctx.bundle = bundleOf(ctx.proc);
        return ctx.bundle;
    }

    identify(ctx, index) {
        const bundle = this._bundle(ctx);
        const snap = ctx.env.SNAP_INSTANCE_NAME || ctx.env.SNAP_NAME ||
            (bundle?.kind === 'snap' ? bundle.root.split('/')[2] : null);
        const bySnap = snap && index.find(index.map('snap'), snap, ctx);
        if (bySnap)
            return {id: bySnap};

        const appImage = canonical(ctx.env.APPIMAGE) ?? bundle?.file;
        const byFile = appImage &&
            (index.exactPath([appImage]) ?? index.lookup(exeStem(appImage)) ?? this._wrapperOf(appImage, index));
        if (byFile)
            return {id: byFile};
        // An entry on the host made from the bundle's own: the same window
        // class or the same icon name (a package of the same app).
        const own = bundle?.entry;
        const byOwn = own && (index.wmClass.get(own.wmClass?.toLowerCase()) ?? index.icon.get(own.icon?.toLowerCase()));
        return byOwn ? {id: byOwn} : null;
    }

    // Without an entry on the host: the bundle's own name and icon.
    fallback(ctx) {
        const bundle = this._bundle(ctx);
        if (!bundle?.entry && !bundle?.icon)
            return null;
        return {icon: bundle.icon, name: bundle.entry?.name ?? null};
    }

    // The entry whose program is a script that runs the AppImage, by its
    // path or as the same file (APPIMAGE is the real path: /var/opt/... for
    // a script's /opt/... on Silverblue).
    _wrapperOf(appImage, index) {
        const id = fileId(appImage);
        const runs = path => path === appImage || (id && fileId(path) === id);
        const ids = [...index.program.keys()];
        return ids.find(entry => (this._scripts.get(index.program.get(entry)) ?? []).some(runs)) ?? null;
    }
}
