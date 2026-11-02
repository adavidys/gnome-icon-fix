// The icon theme, as docks and KDE use it: an icon named after the
// window's class or program (osu!'s window is classed "osu!", and
// /usr/share/icons/hicolor/*/apps/osu!.png is its icon), found in every
// folder the theme looks in, /usr/share/pixmaps too. For windows nothing
// else gave an icon.

export class ThemeSource {
    constructor() {
        this.name = 'theme';
    }

    // Names to try in turn (extension.js _realize()).
    fallback(ctx) {
        const names = [...new Set([ctx.wmClass, ctx.wmInstance, ...ctx.stems]
            .filter(Boolean).flatMap(n => [n, n.toLowerCase()]))];
        return names.length ? {iconName: names} : null;
    }
}
