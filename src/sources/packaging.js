// App packaging formats. Flatpak needs nothing here: Mutter reports a
// window's sandboxed app id and the matcher looks it up directly.
//
// Snap: entries are <snap>_<app>.desktop and the process has SNAP_NAME.
// AppImage: the program runs from a temporary mount, but APPIMAGE holds the
// file the entry (AppImageLauncher, Gear Lever...) launches.

import {canonical, exeStem} from '../lib/util.js';

export class PackagingSource {
    constructor() {
        this.name = 'packaging';
        this.envKeys = ['SNAP_INSTANCE_NAME', 'SNAP_NAME', 'APPIMAGE'];
    }

    indexEntry(entry, _argv, index) {
        const snap = entry.id.match(/^([a-z0-9][a-z0-9-]*)_[\w-]+\.desktop$/)?.[1];
        if (snap && entry.exec?.includes('/snap/bin/'))
            index.add(index.map('snap'), snap, entry.id);
        return false;
    }

    identify(ctx, index) {
        const snap = ctx.env.SNAP_INSTANCE_NAME || ctx.env.SNAP_NAME;
        const bySnap = snap && index.find(index.map('snap'), snap, ctx);
        if (bySnap)
            return {id: bySnap};

        const appImage = canonical(ctx.env.APPIMAGE);
        const byFile = appImage && (index.exactPath([appImage]) ?? index.lookup(exeStem(appImage)));
        return byFile ? {id: byFile} : null;
    }
}
