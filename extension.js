// When GNOME can't map a window to a .desktop file it creates a
// "window-backed" app with a generic icon. Instead of requiring
// StartupWMClass, we guess the right .desktop entry (KDE-style heuristics,
// see matcher.js) and make those apps report its icon and name.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppIndex, match, readProcess} from './matcher.js';

export default class IconFixExtension extends Extension {
    enable() {
        this._appSystem = Shell.AppSystem.get_default();
        this._tracker = Shell.WindowTracker.get_default();
        this._iconTheme = new St.IconTheme();
        this._cache = new WeakMap();
        this._windows = new Set();
        this._pendingNotify = new Set();
        this._notifyId = 0;

        this._buildIndex();
        this._appSystem.connectObject('installed-changed', () => {
            this._iconTheme = new St.IconTheme();
            this._buildIndex();
            this._cache = new WeakMap();
            this._refreshRunning();
        }, this);

        global.display.connectObject('window-created',
            (_display, win) => this._watchWindow(win), this);
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);

        this._patch();
        this._refreshRunning();
    }

    disable() {
        this._unpatch();

        global.display.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        for (const win of this._windows)
            win.disconnectObject(this);
        this._windows.clear();

        if (this._notifyId) {
            GLib.source_remove(this._notifyId);
            this._notifyId = 0;
        }
        this._pendingNotify.clear();

        // Let docks and switchers go back to the stock icons.
        this._refreshRunning();

        this._appSystem = null;
        this._tracker = null;
        this._iconTheme = null;
        this._cache = null;
        this._index = null;
    }

    _buildIndex() {
        const entries = [];
        for (const info of this._appSystem.get_installed()) {
            // Gio.DesktopAppInfo moved to GioUnix in newer GLib; duck-type it.
            if (typeof info.get_string !== 'function' || !info.get_id())
                continue;
            entries.push({
                id: info.get_id(),
                name: info.get_name(),
                wmClass: info.get_startup_wm_class(),
                exec: info.get_string('Exec'),
                icon: info.get_string('Icon'),
            });
        }
        this._index = new AppIndex(entries);
    }

    _patch() {
        const proto = Shell.App.prototype;
        const orig = {
            create_icon_texture: proto.create_icon_texture,
            get_icon: proto.get_icon,
            get_name: proto.get_name,
        };
        this._orig = orig;
        const ext = this;

        proto.create_icon_texture = function (size) {
            const found = ext._resolve(this);
            if (found?.app)
                return orig.create_icon_texture.call(found.app, size);
            if (found?.gicon) {
                return new St.Icon({
                    gicon: found.gicon,
                    icon_size: size,
                    style_class: 'icon-dropshadow',
                });
            }
            return orig.create_icon_texture.call(this, size);
        };

        proto.get_icon = function () {
            const found = ext._resolve(this);
            if (found?.app)
                return orig.get_icon.call(found.app);
            return found?.gicon ?? orig.get_icon.call(this);
        };

        proto.get_name = function () {
            const found = ext._resolve(this);
            if (found?.app)
                return orig.get_name.call(found.app);
            return orig.get_name.call(this);
        };
    }

    _unpatch() {
        if (!this._orig)
            return;
        Object.assign(Shell.App.prototype, this._orig);
        this._orig = null;
    }

    // Returns {app: Shell.App} or {gicon: Gio.Icon} for a window-backed
    // app we could identify, null otherwise.
    _resolve(app) {
        if (!this._index || !app.is_window_backed())
            return null;

        const cached = this._cache.get(app);
        const win = app.get_windows()[0];
        if (!win)
            return cached?.result ?? null;

        const key = `${win.get_wm_class()}\n${win.get_pid()}`;
        const title = win.get_title();
        // A hit is kept while class and pid stay; a miss is retried when the
        // title changes, since the title is one of the things we match on.
        if (cached?.key === key && (cached.result || cached.title === title))
            return cached.result;

        // Same process as last time: only the title changed, so reuse what
        // /proc told us instead of reading it again (titles can change at
        // frame rate, e.g. FPS counters).
        const proc = cached?.key === key ? cached.proc : readProcess(win.get_pid());
        const found = match(this._index, {
            wmClass: win.get_wm_class(),
            wmInstance: win.get_wm_class_instance(),
            gtkId: win.get_gtk_application_id(),
            sandboxId: win.get_sandboxed_app_id(),
            title,
            proc,
        });

        let result = null;
        if (found?.id) {
            const target = this._appSystem.lookup_app(found.id);
            if (target)
                result = {app: target, tag: found.id};
        } else if (found?.steamId) {
            const name = `steam_icon_${found.steamId}`;
            if (this._iconTheme.has_icon(name))
                result = {gicon: new Gio.ThemedIcon({name}), tag: name};
        }

        this._cache.set(app, {key, title, proc, result});
        if (cached && cached.result?.tag !== result?.tag)
            this._queueNotify(app);
        return result;
    }

    _watchWindow(win) {
        if (this._windows.has(win))
            return;
        this._windows.add(win);
        const recheck = () => {
            const app = this._tracker.get_window_app(win);
            if (app?.is_window_backed())
                this._resolve(app);
        };
        win.connectObject(
            'notify::wm-class', recheck,
            'notify::title', recheck,
            'unmanaged', () => {
                win.disconnectObject(this);
                this._windows.delete(win);
            }, this);
    }

    _refreshRunning() {
        this._refreshIcons(new Set(
            this._appSystem.get_running().filter(app => app.is_window_backed())));
    }

    // notify::icon alone is not enough: dash-to-dock only listens to it for
    // its location icons, so also rebuild every BaseIcon showing these apps.
    _refreshIcons(apps) {
        if (!apps.size)
            return;
        for (const app of apps)
            app.notify('icon');

        const walk = actor => {
            if (apps.has(actor.app) && typeof actor.icon?.update === 'function')
                actor.icon.update();
            for (const child of actor.get_children())
                walk(child);
        };
        walk(Main.layoutManager.uiGroup);
    }

    // Icons get recreated on notify::icon; do it outside of whatever
    // (possibly paint-time) code path called us.
    _queueNotify(app) {
        this._pendingNotify.add(app);
        if (this._notifyId)
            return;
        this._notifyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._refreshIcons(this._pendingNotify);
            this._pendingNotify.clear();
            this._notifyId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}
