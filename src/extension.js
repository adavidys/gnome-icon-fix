// When GNOME can't map a window to a .desktop file it creates a
// "window-backed" app with a generic icon. Instead of requiring
// StartupWMClass, we guess the right .desktop entry (KDE-style heuristics,
// see lib/matcher.js and sources/) and make those apps report its icon and
// name.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppIndex} from './lib/appindex.js';
import {matchTitle, matchWindow} from './lib/matcher.js';
import {readProcess} from './lib/process.js';
import {FlatpakSteamMirror} from './mirror/steam-flatpak.js';
import {createSources, envKeys} from './sources/registry.js';
import {WindowSplitter} from './split.js';

export default class IconFixExtension extends Extension {
    enable() {
        this._appSystem = Shell.AppSystem.get_default();
        this._tracker = Shell.WindowTracker.get_default();
        this._iconTheme = new St.IconTheme();
        this._cache = new WeakMap();
        // pid -> what /proc says about it. Unlike _cache it survives index
        // rebuilds (installed-changed fires in bursts while Steam installs),
        // and is dropped when the process's last window goes away.
        this._procs = new Map();
        this._sources = createSources();
        this._envKeys = envKeys(this._sources);
        this._windows = new Set();
        this._pendingNotify = new Set();
        this._notifyId = 0;

        this._buildIndex();
        this._appSystem.connectObject('installed-changed', () => {
            this._iconTheme = new St.IconTheme();
            this._buildIndex();
            this._cache = new WeakMap();
            this._splitter.recheckAll();
            this._refreshRunning();
        }, this);

        global.display.connectObject('window-created',
            (_display, win) => this._watchWindow(win), this);
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);

        this._settings = this.getSettings();
        this._settings.connectObject('changed::flatpak-steam',
            () => this._syncFlatpakSteam(true), this);
        this._syncFlatpakSteam(false);

        this._patch();
        this._splitter = new WindowSplitter(win => this._launcherGameApp(win));
        this._refreshRunning();
    }

    disable() {
        this._splitter.destroy();
        this._splitter = null;
        this._unpatch();

        // Keep the generated shortcuts: disable() also runs on screen lock.
        this._flatpakMirror?.destroy();
        this._flatpakMirror = null;
        this._settings.disconnectObject(this);
        this._settings = null;

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
        this._procs = null;
        this._sources = null;
        this._envKeys = null;
        this._index = null;
    }

    _syncFlatpakSteam(toggled) {
        const enabled = this._settings.get_boolean('flatpak-steam');
        if (enabled && !this._flatpakMirror) {
            this._flatpakMirror = new FlatpakSteamMirror();
        } else if (!enabled) {
            this._flatpakMirror?.destroy();
            this._flatpakMirror = null;
            if (toggled)
                FlatpakSteamMirror.removeAll();
        }
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
                path: info.get_string('Path'),
            });
        }
        this._index = new AppIndex(entries, this._sources);
    }

    _patch() {
        const proto = Shell.App.prototype;
        const ext = this;
        this._injections = new InjectionManager();

        this._injections.overrideMethod(proto, 'create_icon_texture', original => function (size) {
            const found = ext._resolve(this);
            if (found?.app)
                return original.call(found.app, size);
            if (found?.gicon) {
                return new St.Icon({
                    gicon: found.gicon,
                    icon_size: size,
                    style_class: 'icon-dropshadow',
                });
            }
            return original.call(this, size);
        });

        this._injections.overrideMethod(proto, 'get_icon', original => function () {
            const found = ext._resolve(this);
            if (found?.app)
                return original.call(found.app);
            return found?.gicon ?? original.call(this);
        });

        this._injections.overrideMethod(proto, 'get_name', original => function () {
            const found = ext._resolve(this);
            if (found?.app)
                return original.call(found.app);
            return found?.name ?? original.call(this);
        });
    }

    _unpatch() {
        this._injections?.clear();
        this._injections = null;
    }

    // Returns {app: Shell.App} or {gicon: Gio.Icon | null, name} for a
    // window-backed app we could identify, null otherwise.
    _resolve(app) {
        if (!this._index || !app.is_window_backed())
            return null;

        const cached = this._cache.get(app);
        const win = app.get_windows()[0];
        if (!win)
            return cached?.result ?? null;

        const pid = win.get_pid();
        const key = `${win.get_wm_class()}\n${pid}`;
        const title = win.get_title();
        if (cached?.key === key && cached.title === title)
            return cached.result;

        // Everything but the title is looked up once per class and process
        // (and again after the index changes). Titles can change at frame
        // rate (FPS counters), so a title change only redoes that lookup.
        let found = cached?.key === key ? cached : null;
        if (!found) {
            const {primary, fallbacks} = matchWindow(this._index, this._sources, {
                wmClass: win.get_wm_class(),
                wmInstance: win.get_wm_class_instance(),
                gtkId: win.get_gtk_application_id(),
                sandboxId: win.get_sandboxed_app_id(),
                proc: this._procInfo(pid),
            });
            const shown = fallbacks.map(f => this._realize(f)).filter(Boolean);
            found = {
                key,
                primary: this._realize(primary),
                // An icon beats a name alone.
                fallback: shown.find(f => f.gicon) ?? shown[0] ?? null,
            };
        }

        const result = found.primary ?? this._realize(matchTitle(this._index, title)) ?? found.fallback;
        this._cache.set(app, {key, primary: found.primary, fallback: found.fallback, title, result});
        if (cached && cached.result?.tag !== result?.tag)
            this._queueNotify(app);
        return result;
    }

    // Turns a match into what the patched methods return, or null when it
    // can't be shown (the entry or icon has gone away).
    _realize(found) {
        if (!found)
            return null;
        if (found.id) {
            const app = this._appSystem.lookup_app(found.id);
            return app ? {app, tag: found.id} : null;
        }
        let gicon = null;
        let tag = null;
        if (found.iconName && this._iconTheme.has_icon(found.iconName)) {
            gicon = new Gio.ThemedIcon({name: found.iconName});
            tag = found.iconName;
        } else if (found.icon && GLib.file_test(found.icon, GLib.FileTest.EXISTS)) {
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(found.icon)});
            tag = found.icon;
        }
        if (!gicon && !found.name)
            return null;
        return {gicon, name: found.name ?? null, tag: `${tag}\n${found.name}`};
    }

    // For a window inside a launcher's Flatpak sandbox: the app of the game
    // running in it. Matched as if it weren't sandboxed, so the launcher's
    // own windows (no game id in their environment) stay with the launcher.
    _launcherGameApp(win) {
        if (!this._index)
            return null;
        const {primary} = matchWindow(this._index, this._sources, {
            wmClass: win.get_wm_class(),
            wmInstance: win.get_wm_class_instance(),
            gtkId: win.get_gtk_application_id(),
            proc: this._procInfo(win.get_pid()),
        });
        return primary ? this._appSystem.lookup_app(primary.id) : null;
    }

    _procInfo(pid) {
        let info = this._procs.get(pid);
        if (!info) {
            info = readProcess(pid, this._envKeys);
            this._procs.set(pid, info);
        }
        return info;
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
                const pid = win.get_pid();
                if (![...this._windows].some(w => w.get_pid() === pid))
                    this._procs.delete(pid);
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
