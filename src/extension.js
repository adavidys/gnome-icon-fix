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

import {Tracer, clearTrace} from './debug/trace.js';
import {AppIndex, parseExec, tryCall} from './lib/appindex.js';
import * as log from './lib/log.js';
import {matchTitle, matchWindow} from './lib/matcher.js';
import {readProcess} from './lib/process.js';
import {findSandboxedIcon} from './lib/util.js';
import {FlatpakBottlesMirror} from './mirror/bottles-flatpak.js';
import {FlatpakSteamMirror} from './mirror/steam-flatpak.js';
import {createSources, envKeys} from './sources/registry.js';
import {WindowSplitter} from './split.js';

// installed-changed comes in bursts (Steam installing a game rewrites its
// shortcut several times): rebuild once they settle.
const REINDEX_DELAY_MS = 300;

// The D-Bus service that runs extension preferences.
const PREFS_SERVICE = 'org.gnome.Shell.Extensions';

// setting -> the mirror it switches on
const MIRRORS = [
    ['flatpak-steam', FlatpakSteamMirror],
    ['flatpak-bottles', FlatpakBottlesMirror],
];

export default class IconFixExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        log.setDebug(this._settings.get_boolean('debug-logging'));
        this._settings.connectObject('changed::debug-logging',
            () => log.setDebug(this._settings.get_boolean('debug-logging')), this);

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
        this._reindexId = 0;

        this._buildIndex();
        this._appSystem.connectObject('installed-changed', () => this._queueReindex(), this);

        global.display.connectObject('window-created',
            (_display, win) => this._watchWindow(win), this);
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);

        // Optional shortcut mirrors, each behind its own setting.
        this._mirrors = new Map();
        for (const [key, Mirror] of MIRRORS) {
            this._settings.connectObject(`changed::${key}`, () => this._syncMirror(key, Mirror, true), this);
            this._syncMirror(key, Mirror, false);
        }

        this._patch();
        this._splitter = new WindowSplitter((win, splitter) => this._launcherGameApp(win, splitter));
        this._refreshRunning();

        // The trace behind the Debug tab, while the preferences are open;
        // set up last so it sees what Icon Fix shows.
        this._settings.connectObject('changed::debug-watching', () => this._syncTracer(), this);
        this._syncTracer();
    }

    _syncTracer() {
        const enabled = this._settings.get_boolean('debug-watching');
        if (enabled && !this._tracer) {
            try {
                this._tracer = new Tracer();
            } catch (e) {
                log.error('debug trace', e);
                return;
            }
            // Preferences that crash or get killed never say they closed:
            // stop when the service running them goes away.
            this._prefsWatch = Gio.bus_watch_name(Gio.BusType.SESSION, PREFS_SERVICE,
                Gio.BusNameWatcherFlags.NONE, null,
                () => this._settings?.set_boolean('debug-watching', false));
        } else if (!enabled && this._tracer) {
            this._stopTracer();
        }
    }

    _stopTracer() {
        Gio.bus_unwatch_name(this._prefsWatch);
        this._prefsWatch = 0;
        this._tracer.destroy();
        this._tracer = null;
        clearTrace();
    }

    disable() {
        // Keep the trace: disable() also runs on screen lock.
        if (this._tracer) {
            Gio.bus_unwatch_name(this._prefsWatch);
            this._tracer.destroy();
            this._tracer = null;
        }
        this._splitter.destroy();
        this._splitter = null;
        this._unpatch();

        // Keep the generated shortcuts: disable() also runs on screen lock.
        for (const mirror of this._mirrors.values())
            mirror.destroy();
        this._mirrors = null;
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
        if (this._reindexId) {
            GLib.source_remove(this._reindexId);
            this._reindexId = 0;
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

    // A mirror that fails must not take the rest of the extension down.
    _syncMirror(key, Mirror, toggled) {
        const enabled = this._settings.get_boolean(key);
        try {
            if (enabled && !this._mirrors.has(key)) {
                this._mirrors.set(key, new Mirror());
            } else if (!enabled) {
                this._mirrors.get(key)?.destroy();
                this._mirrors.delete(key);
                if (toggled)
                    Mirror.removeAll();
            }
        } catch (e) {
            log.error(`${key}`, e);
        }
    }

    _queueReindex() {
        if (this._reindexId)
            GLib.source_remove(this._reindexId);
        this._reindexId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REINDEX_DELAY_MS, () => {
            this._reindexId = 0;
            this._iconTheme = new St.IconTheme();
            this._buildIndex();
            this._cache = new WeakMap();
            this._splitter.recheckAll();
            this._refreshRunning();
            return GLib.SOURCE_REMOVE;
        });
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
        this._index = log.timed(`indexed ${entries.length} apps`, () => new AppIndex(entries, this._sources));
    }

    _patch() {
        const proto = Shell.App.prototype;
        const ext = this;
        this._injections = new InjectionManager();

        // A matched entry goes through these patched methods too: its own
        // icon may need replacing (see _entryIcon()).
        this._injections.overrideMethod(proto, 'create_icon_texture', original => function (size) {
            const found = ext._resolve(this);
            if (found?.app)
                return found.app.create_icon_texture(size);
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
                return found.app.get_icon();
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
    // window-backed app we could identify, {gicon} for an entry whose icon
    // we found elsewhere, null otherwise.
    _resolve(app) {
        if (!this._index)
            return null;
        if (!app.is_window_backed())
            return this._entryIcon(app);

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
            found = {
                key,
                primary: this._realize(primary),
                fallback: this._fallback(fallbacks),
            };
            log.debug(`window "${title}" (${win.get_wm_class()}, pid ${pid}): ${describe(found)}`);
        }

        const result = found.primary ?? this._realize(matchTitle(this._index, title)) ?? found.fallback;
        this._cache.set(app, {key, primary: found.primary, fallback: found.fallback, title, result});
        if (cached && cached.result?.tag !== result?.tag)
            this._queueNotify(app);
        return result;
    }

    // A desktop entry whose icon can't be shown gets a real one instead of a
    // blank one: an icon its launcher kept inside its Flatpak sandbox
    // (Lutris' "Create application menu shortcut", Steam's shortcuts), else
    // the icon of the game it launches (its .exe's) when there's none at all.
    _entryIcon(app) {
        const cached = this._cache.get(app);
        if (cached)
            return cached.result;
        let path = null;
        const info = app.get_app_info();
        const icon = info?.get_icon();
        if (info && !this._iconShown(icon)) {
            if (icon instanceof Gio.ThemedIcon)
                path = icon.get_names().map(name => findSandboxedIcon(name)).find(Boolean) ?? null;
            path ??= this._programIcon(info);
        }
        const result = path ? {gicon: new Gio.FileIcon({file: Gio.File.new_for_path(path)})} : null;
        if (result)
            log.debug(`${app.get_id()}: its icon ${icon?.to_string() ?? '(none)'} can't be shown, using ${path}`);
        this._cache.set(app, {result});
        return result;
    }

    _iconShown(icon) {
        if (icon instanceof Gio.ThemedIcon)
            return icon.get_names().some(name => this._iconTheme.has_icon(name));
        if (icon instanceof Gio.FileIcon)
            return icon.get_file().query_exists(null);
        return !!icon;
    }

    // Asks the sources for the icon of what an entry launches.
    _programIcon(info) {
        // Gio.DesktopAppInfo moved to GioUnix in newer GLib; duck-type it.
        const exec = typeof info.get_string === 'function' ? info.get_string('Exec') : null;
        if (!exec)
            return null;
        const entry = {id: info.get_id() ?? '', exec, icon: info.get_string('Icon')};
        const argv = parseExec(exec);
        for (const source of this._sources) {
            const path = tryCall(source, 'entryIcon', entry, argv);
            if (path && GLib.file_test(path, GLib.FileTest.EXISTS))
                return path;
        }
        return null;
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

    // What the sources would show without an entry, combined: the best
    // source's name and the best source's icon need not be the same one
    // (a launcher knows the title, the .exe has the icon).
    _fallback(fallbacks) {
        const shown = fallbacks.map(f => this._realize(f)).filter(Boolean);
        if (!shown.length)
            return null;
        const gicon = shown.find(f => f.gicon)?.gicon ?? null;
        const name = shown.find(f => f.name)?.name ?? null;
        return {gicon, name, tag: `${gicon?.to_string()}\n${name}`};
    }

    // For a window inside a launcher's Flatpak sandbox: the app of the game
    // running in it. Matched as if it weren't sandboxed, so the launcher's
    // own windows (no game id in their environment) stay with the launcher.
    _launcherGameApp(win, splitter) {
        if (!this._index)
            return null;
        const {primary, fallbacks} = matchWindow(this._index, this._sources, {
            wmClass: win.get_wm_class(),
            wmInstance: win.get_wm_class_instance(),
            gtkId: win.get_gtk_application_id(),
            launcherSandbox: win.get_sandboxed_app_id(),
            proc: this._procInfo(win.get_pid()),
        });
        log.debug(`launcher window "${win.get_title()}" (${win.get_wm_class()}, ${win.get_sandboxed_app_id()}): ` +
            `${primary ? `entry ${primary.id}` : `no entry, fallbacks ${JSON.stringify(fallbacks)}`}`);
        if (primary)
            return this._appSystem.lookup_app(primary.id);

        // No .desktop for it (Flatpak Bottles can't create one, Heroic
        // doesn't for sideloaded games): still give the game its own entry
        // if the sources know its name and icon.
        const shown = this._fallback(fallbacks);
        return shown?.gicon && shown.name ? splitter.virtualApp(shown.name, shown.gicon, shown.tag) : null;
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
            this._appSystem.get_running().filter(app => app.is_window_backed() || this._resolve(app))));
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

// For the debug log: what a window was matched to.
function describe({primary, fallback}) {
    if (primary)
        return `entry ${primary.tag}`;
    if (fallback)
        return `no entry, showing "${fallback.name}" with ${fallback.gicon?.to_string() ?? 'no icon'}`;
    return 'nothing found, left as is';
}
