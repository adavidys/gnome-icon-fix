// When GNOME can't map a window to a .desktop file it creates a
// "window-backed" app with a generic icon. Instead of requiring
// StartupWMClass, we guess the right .desktop entry (KDE-style heuristics,
// see lib/matcher.js and sources/) and make those apps report its icon and
// name. A window GNOME gave to its Flatpak sandbox's app while it belongs
// to another entry (a game a Flatpak launcher started) moves there
// (split.js). Square icons Icon Fix shows get rounded corners
// (lib/shape.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Tracer, clearTrace} from './debug/trace.js';
import {AppIndex, parseExec, tryCall} from './lib/appindex.js';
import * as log from './lib/log.js';
import {pick, shownTitle} from './lib/look.js';
import {forgetBundles} from './lib/bundle.js';
import {leavesSandbox, matchTitle, matchWindow} from './lib/matcher.js';
import {forgetRead} from './lib/peicon.js';
import {readProcess} from './lib/process.js';
import {forgetRounded, roundedIcon} from './lib/shape.js';
import {findPixmap, findSandboxedIcon} from './lib/util.js';
import {MIRRORS} from './mirror/registry.js';
import {createSources, envKeys} from './sources/registry.js';
import {WindowSplitter} from './split.js';

// installed-changed comes in bursts (Steam installing a game rewrites its
// shortcut several times): rebuild once they settle.
const REINDEX_DELAY_MS = 300;

// The D-Bus service that runs extension preferences.
const PREFS_SERVICE = 'org.gnome.Shell.Extensions';

// Icons are looked up this big to be rounded (lib/shape.js).
const ROUND_LOOKUP_SIZE = 256;

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
        // Where icons and names come from, first choice first (lib/look.js),
        // and what an entry shows while a window moved to it (split.js)
        // shows something else than the entry's own.
        this._readOrders();
        this._settings.connectObject(
            'changed::icon-order', () => this._readOrders(true),
            'changed::name-order', () => this._readOrders(true),
            'changed::corner-radius', () => this._readOrders(true), this);
        this._looks = new WeakMap();
        // Entries Icon Fix found for windows: their icons are its to round
        // too (_entryIcon()).
        this._placed = new WeakSet();
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
        for (const mirror of MIRRORS) {
            this._settings.connectObject(`changed::${mirror.key}`, () => this._syncMirror(mirror, true), this);
            this._syncMirror(mirror, false);
        }

        this._patch();
        // Windows GNOME made up an app for go to the entry the sources
        // found (not one only the title matched: titles change).
        this._splitter = new WindowSplitter((win, splitter, host) => host.is_window_backed()
            ? this._backedEntry(host)
            : this._sandboxedApp(win, splitter, host));
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
                this._tracer = new Tracer((win, app, moved) => this._explain(win, app, moved));
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
        forgetRead();
        forgetBundles();
        forgetRounded();

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
        this._looks = null;
        this._placed = null;
        this._procs = null;
        this._sources = null;
        this._envKeys = null;
        this._index = null;
    }

    // A mirror that fails must not take the rest of the extension down.
    // toggled: switched off now, so its files go too.
    _syncMirror({key, start, removeAll}, toggled) {
        const enabled = this._settings.get_boolean(key);
        try {
            if (enabled && !this._mirrors.has(key)) {
                this._mirrors.set(key, start());
            } else if (!enabled) {
                this._mirrors.get(key)?.destroy();
                this._mirrors.delete(key);
                if (toggled)
                    removeAll();
            }
        } catch (e) {
            log.error(`${key}`, e);
        }
    }

    // again: the order changed, every window is looked at again.
    _readOrders(again = false) {
        this._iconOrder = this._settings.get_strv('icon-order');
        this._nameOrder = this._settings.get_strv('name-order');
        this._radius = this._settings.get_int('corner-radius');
        // Without .desktop first, the .exe's icon or name may be shown
        // though an entry was found: look for it then too.
        this._allFallbacks = this._iconOrder[0] !== 'desktop' || this._nameOrder[0] !== 'desktop';
        if (again)
            this._queueReindex();
    }

    _queueReindex() {
        if (this._reindexId)
            GLib.source_remove(this._reindexId);
        this._reindexId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REINDEX_DELAY_MS, () => {
            this._reindexId = 0;
            this._iconTheme = new St.IconTheme();
            this._buildIndex();
            this._cache = new WeakMap();
            this._looks = new WeakMap();
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
                noDisplay: info.get_nodisplay(),
                mimeType: info.get_string('MimeType'),
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

        this._injections.overrideMethod(proto, 'get_icon', original => {
            // GNOME's own, for "default" (lib/look.js)
            ext._gnomeIcon = app => original.call(app);
            return function () {
                const found = ext._resolve(this);
                if (found?.app)
                    return found.app.get_icon();
                return found?.gicon ?? original.call(this);
            };
        });
        this._injections.overrideMethod(proto, 'get_name', original => {
            ext._gnomeName = app => original.call(app);
            return function () {
                const found = ext._resolve(this);
                if (found?.app)
                    return original.call(found.app);
                return found?.name ?? original.call(this);
            };
        });

        // Window titles, for every part of the Shell (and other
        // extensions) showing them next to the app's name: the window
        // switcher, the overview, window lists. Icon Fix itself reads the
        // real one (_rawTitle()).
        const winProto = Meta.Window.prototype;
        this._injections.overrideMethod(winProto, 'get_title', original => {
            ext._rawTitle = win => original.call(win);
            return function () {
                return ext._shownTitle(this, original.call(this));
            };
        });
        // The title property too, which GJS defines again on each kind of
        // window (Wayland, X11), found as windows of each kind come.
        this._titleProperties = new Map();
        this._patchTitle(winProto);
        for (const actor of global.get_window_actors())
            this._patchTitle(actor.meta_window);
    }

    // The title property on a window's prototype and those it inherits
    // from: prototype -> its own, to put back in _unpatch().
    _patchTitle(object) {
        if (!this._titleProperties)
            return;
        const ext = this;
        for (let proto = object; proto && proto !== GObject.Object.prototype; proto = Object.getPrototypeOf(proto)) {
            const own = Object.getOwnPropertyDescriptor(proto, 'title');
            if (!own?.get || !own.configurable || this._titleProperties.has(proto))
                continue;
            this._titleProperties.set(proto, own);
            Object.defineProperty(proto, 'title', {
                ...own,
                get() {
                    return ext._shownTitle(this, own.get.call(this));
                },
            });
        }
    }

    // What a window's title shows (lib/look.js shownTitle()): for a window
    // Icon Fix placed, one that agrees with its app's name; any other's as
    // it is.
    _shownTitle(win, title) {
        if (!this._index || this._inTitle)
            return title;
        this._inTitle = true;
        try {
            const app = this._tracker.get_window_app(win);
            const placed = app && (app.is_window_backed() ? !!this._cache.get(app)?.result : this._splitter?.moved(win));
            return placed ? shownTitle(title, app.get_name()) : title;
        } finally {
            this._inTitle = false;
        }
    }

    // Tells whatever shows these apps' windows that their titles changed.
    _notifyTitles(apps) {
        for (const app of apps) {
            for (const win of Shell.App.prototype.get_windows.call(app))
                win.notify('title');
            for (const win of this._splitter?.windowsOf(app) ?? [])
                win.notify('title');
        }
    }

    _unpatch() {
        this._injections?.clear();
        this._injections = null;
        for (const [proto, own] of this._titleProperties ?? [])
            Object.defineProperty(proto, 'title', own);
        this._titleProperties = null;
    }

    // Returns {app: Shell.App} or {gicon: Gio.Icon | null, name} for a
    // window-backed app we could identify, {gicon} for an entry whose icon
    // we found elsewhere, null otherwise.
    _resolve(app) {
        if (!this._index)
            return null;
        if (!app.is_window_backed())
            return this._movedLook(app) ?? this._entryIcon(app);

        const cached = this._cache.get(app);
        // Its own window, also once moved to the game's entry (split.js).
        const win = Shell.App.prototype.get_windows.call(app)[0];
        if (!win)
            return cached?.result ?? null;

        const pid = win.get_pid();
        const key = `${win.get_wm_class()}\n${pid}`;
        const title = this._rawTitle(win);
        if (cached?.key === key && cached.title === title)
            return cached.result;

        // Everything but the title is looked up once per class and process
        // (and again after the index changes). Titles can change at frame
        // rate (FPS counters), so a title change only redoes that lookup.
        let found = cached?.key === key ? cached : null;
        if (!found) {
            const {primary, fallbacks, launcher} = this._match(win, false, this._allFallbacks);
            found = {key, primary: this._realize(primary), fallbacks, launcher};
            log.debug(`window "${title}" (${win.get_wm_class()}, pid ${pid}): ` +
                `${found.primary ? `entry ${found.primary.tag}` : `fallbacks ${JSON.stringify(fallbacks)}`}`);
        }

        // Its entry (by the sources, else by the title) when its icon and
        // name are both to come from .desktop; else what the order says.
        const entry = found.primary ?? this._realize(matchTitle(this._index, title, found.launcher));
        this._place(entry?.app);
        const look = this._choose(entry?.app ?? null, found.fallbacks, app);
        let result = look;
        if (look.iconKind === 'default' && look.nameKind === 'default')
            result = null;
        else if (entry && look.iconKind === 'desktop' && look.nameKind === 'desktop')
            result = entry;
        // The window goes to its entry (split.js), which shows the same;
        // with GNOME's own icon and name both first, it stays as GNOME has it.
        const moveTo = result && found.primary ? found.primary.app : null;
        if (moveTo)
            this._setLook(moveTo, result === entry ? null : look.whole);
        this._cache.set(app, {key, primary: found.primary, fallbacks: found.fallbacks, launcher: found.launcher, title, result, moveTo});
        if (cached && cached.result?.tag !== result?.tag)
            this._queueNotify(app);
        return result;
    }

    // A desktop entry whose icon can't be shown gets a real one instead of a
    // blank one: an icon its launcher kept inside its Flatpak sandbox
    // (Lutris' "Create application menu shortcut", Steam's shortcuts), else
    // the icon of the game it launches (its .exe's) when there's none at all.
    // In the icon order: the .desktop's own (where its launcher put it), the
    // .exe's, or none (GNOME's blank one).
    // The icons of Icon Fix's entries (a launcher's game shortcuts, entries
    // it found for windows) are rounded when square (_round()).
    _entryIcon(app) {
        const cached = this._cache.get(app);
        if (cached)
            return cached.result;
        let path = null;
        const info = app.get_app_info();
        const icon = info?.get_icon() ?? null;
        if (info && !this._iconShown(icon)) {
            const runs = this._index.flavor.get(app.get_id());
            const own = icon instanceof Gio.ThemedIcon
                ? icon.get_names().map(name => findSandboxedIcon(name, runs ? [runs] : []) ?? findPixmap(name))
                    .find(Boolean) ?? null
                : null;
            path = pick(this._iconOrder, {
                desktop: own ?? this._programIcon(info, s => s.name !== 'exe'),
                exe: this._programIcon(info, s => s.name === 'exe'),
            }).value;
        }
        const shown = path ? new Gio.FileIcon({file: Gio.File.new_for_path(path)}) : icon;
        const ours = path || this._index.owner.has(app.get_id()) || this._index.windows.has(app.get_id()) || this._placed.has(app);
        const gicon = shown && ours ? this._round(shown) : shown;
        const result = gicon && gicon !== icon ? {gicon} : null;
        if (result)
            log.debug(`${app.get_id()}: its icon ${icon?.to_string() ?? '(none)'} shown as ${gicon.to_string()}`);
        this._cache.set(app, {result});
        return result;
    }

    // An entry Icon Fix found for a window: from now on its icon is
    // rounded like the ones Icon Fix finds itself.
    _place(app) {
        if (!app || this._placed.has(app))
            return;
        this._placed.add(app);
        if (this._radius > 0) {
            this._cache.delete(app);
            this._queueNotify(app);
        }
    }

    // The icon with rounded corners if it is a square (lib/shape.js), else
    // the icon itself.
    _round(gicon) {
        if (!(this._radius > 0) || !gicon)
            return gicon;
        let path = null;
        if (gicon instanceof Gio.FileIcon)
            path = gicon.get_file().get_path();
        else if (gicon instanceof Gio.ThemedIcon)
            path = this._iconTheme.lookup_by_gicon(gicon, ROUND_LOOKUP_SIZE, 0)?.get_filename() ?? null;
        const rounded = path ? roundedIcon(path, this._radius) : path;
        return rounded && rounded !== path ? new Gio.FileIcon({file: Gio.File.new_for_path(rounded)}) : gicon;
    }

    _iconShown(icon) {
        if (icon instanceof Gio.ThemedIcon)
            return icon.get_names().some(name => this._iconTheme.has_icon(name));
        if (icon instanceof Gio.FileIcon)
            return icon.get_file().query_exists(null);
        return !!icon;
    }

    // Asks the sources (those which) for the icon of what an entry launches.
    _programIcon(info, which) {
        // Gio.DesktopAppInfo moved to GioUnix in newer GLib; duck-type it.
        const exec = typeof info.get_string === 'function' ? info.get_string('Exec') : null;
        if (!exec)
            return null;
        const entry = {id: info.get_id() ?? '', exec, icon: info.get_string('Icon')};
        const argv = parseExec(exec);
        for (const source of this._sources.filter(which)) {
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
        // iconName: a name, or names to try in turn (sources/theme.js)
        const names = [found.iconName ?? []].flat();
        const iconName = names.find(name => this._iconTheme.has_icon(name));
        const pixmap = iconName ? null : names.map(findPixmap).find(Boolean);
        if (iconName) {
            gicon = new Gio.ThemedIcon({name: iconName});
            tag = iconName;
        } else if (pixmap) {
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(pixmap)});
            tag = pixmap;
        } else if (found.icon && GLib.file_test(found.icon, GLib.FileTest.EXISTS)) {
            gicon = new Gio.FileIcon({file: Gio.File.new_for_path(found.icon)});
            tag = found.icon;
        }
        if (!gicon && !found.name)
            return null;
        gicon = this._round(gicon);
        return {gicon, name: found.name ?? null, tag: `${tag}\n${found.name}\n${gicon?.to_string()}`};
    }

    // What a window is shown with, in the user's order (lib/look.js):
    // .desktop is its entry's icon and name, or without one what its
    // launcher knows (the sources' fallbacks); .exe what its program
    // holds; default GNOME's own, for host (the app GNOME gave it).
    // {gicon, name, tag, iconKind, nameKind}: null for GNOME's own; whole:
    // the same with GNOME's own filled in.
    _choose(entryApp, fallbacks, host) {
        const shown = fallbacks.map(f => ({exe: f.source === 'exe', look: this._realize(f)})).filter(f => f.look);
        const first = (exe, key) => shown.filter(f => f.exe === exe).map(f => f.look[key]).find(Boolean) ?? null;
        const icon = pick(this._iconOrder, {
            desktop: entryApp ? this._entryIcon(entryApp)?.gicon ?? this._gnomeIcon(entryApp) : first(false, 'gicon'),
            exe: first(true, 'gicon'),
        });
        const name = pick(this._nameOrder, {
            desktop: entryApp ? this._gnomeName(entryApp) : first(false, 'name'),
            exe: first(true, 'name'),
        });
        const tag = `${icon.kind}:${icon.value?.to_string()}\n${name.kind}:${name.value}`;
        return {
            gicon: icon.value, name: name.value, tag, iconKind: icon.kind, nameKind: name.kind,
            whole: {gicon: icon.value ?? this._gnomeIcon(host), name: name.value ?? this._gnomeName(host), tag},
        };
    }

    // What an entry a window was moved to shows while it has it, when
    // that isn't the entry's own (_choose()); null otherwise.
    _movedLook(app) {
        const look = this._looks.get(app);
        return look && this._splitter?.hosts(app) ? look : null;
    }

    _setLook(app, look) {
        if (this._looks.get(app)?.tag === look?.tag)
            return;
        if (look)
            this._looks.set(app, look);
        else
            this._looks.delete(app);
        this._queueNotify(app);
    }

    // For the Debug tab: every name and icon Icon Fix considered for a
    // window, with where it came from and whether it is the one shown:
    // [{source, kind, id?, name, icon, usesName, usesIcon, missing}].
    _explain(win, app, moved) {
        if (!this._index || !app)
            return [];
        const toString = gicon => gicon?.to_string() ?? null;
        // A desktop entry: only its icon can be replaced (_entryIcon()).
        if (!moved && !app.is_window_backed()) {
            const found = this._entryIcon(app);
            return found ? [{source: 'entry icon', kind: 'icon', name: null, icon: toString(found.gicon),
                usesName: false, usesIcon: true, missing: false}] : [];
        }
        // A window GNOME gave to its sandbox's app is matched as
        // _sandboxedApp() matches it.
        const sandbox = win.get_sandboxed_app_id();
        const inSandbox = !!sandbox && !this._splitter?.gnomeApp(win)?.is_window_backed();
        const matched = this._match(win, inSandbox, true);
        const {fallbacks, launcher} = matched;
        const primary = !inSandbox || leavesSandbox(this._index, matched.primary, launcher, sandbox)
            ? matched.primary : null;
        // What is shown: an entry (found by a source or a guess, or by the
        // title) and the sources' fallbacks, taken in the user's order as
        // _choose() takes them; the rest is listed as what could have been
        // used. A window in a sandbox isn't matched by its title
        // (_sandboxedApp()): that could be another launcher's shortcut.
        const title = primary || inSandbox ? null : matchTitle(this._index, this._rawTitle(win), launcher);
        const headId = primary?.id ?? title?.id ?? null;
        const entryApp = headId ? this._appSystem.lookup_app(headId) : null;
        const look = this._choose(entryApp, fallbacks, app);
        // Nothing is used with GNOME's own icon and name both first, nor for
        // a sandboxed window without an entry unless a launcher started it
        // and it has an icon and a name (it gets an entry of its own only
        // then).
        const gnomes = look.iconKind === 'default' && look.nameKind === 'default';
        const shown = !gnomes && !(inSandbox && !headId &&
            (!launcher || look.iconKind === 'default' || look.nameKind === 'default'));
        const head = headId ? [{source: primary?.by ?? 'window title', kind: 'entry', id: headId,
            name: entryApp ? this._gnomeName(entryApp) : null,
            icon: entryApp ? toString(this._entryIcon(entryApp)?.gicon ?? this._gnomeIcon(entryApp)) : null,
            usesName: shown && look.nameKind === 'desktop', usesIcon: shown && look.iconKind === 'desktop',
            missing: !entryApp}] : [];
        // Only the first icon and name of each kind can be the one shown.
        const taken = {desktop: {icon: !!headId, name: !!headId}, exe: {icon: false, name: false}};
        const listed = [...head, ...fallbacks.map(f => {
            const kind = f.source === 'exe' ? 'exe' : 'desktop';
            const icon = toString(this._realize(f)?.gicon);
            const out = {source: f.source, kind: 'fallback', name: f.name ?? null,
                icon: icon ?? f.icon ?? ([f.iconName ?? []].flat().join(' ') || null),
                usesName: shown && !!f.name && !taken[kind].name && look.nameKind === kind,
                usesIcon: shown && !!icon && !taken[kind].icon && look.iconKind === kind,
                missing: !icon && !!(f.icon || f.iconName)};
            taken[kind].name ||= !!f.name;
            taken[kind].icon ||= !!icon;
            return out;
        })];
        return listed;
    }

    _backedEntry(app) {
        this._resolve(app);
        return this._cache.get(app)?.moveTo ?? null;
    }

    // What the matcher finds for a window. sandboxed: match one from a
    // Flatpak sandbox as if it weren't, for the program running in it
    // rather than the sandbox's app (lib/matcher.js windowContext()).
    _match(win, sandboxed, all) {
        const sandbox = win.get_sandboxed_app_id();
        return matchWindow(this._index, this._sources, {
            wmClass: win.get_wm_class(),
            wmInstance: win.get_wm_class_instance(),
            gtkId: win.get_gtk_application_id(),
            ...sandboxed ? {launcherSandbox: sandbox} : {sandboxId: sandbox},
            proc: this._procInfo(win.get_pid()),
        }, all);
    }

    // For a window GNOME gave to its Flatpak sandbox's app (host): the app
    // it really belongs to, as KDE would place it, or null to leave it.
    // Matched as if it weren't sandboxed; it moves only when that's sure
    // (leavesSandbox()): a game a Flatpak launcher started, another entry
    // of the same Flatpak. The launcher's own windows (no game id in their
    // environment) stay with the launcher.
    _sandboxedApp(win, splitter, host) {
        if (!this._index)
            return null;
        const sandbox = win.get_sandboxed_app_id();
        const {primary, fallbacks, launcher} = this._match(win, true, this._allFallbacks);
        const accepted = leavesSandbox(this._index, primary, launcher, sandbox) ? primary : null;
        const entryApp = accepted ? this._appSystem.lookup_app(accepted.id) : null;
        if (entryApp === host || (!entryApp && !launcher))
            return null;
        log.debug(`sandboxed window "${this._rawTitle(win)}" (${win.get_wm_class()}, ${sandbox}): ` +
            `${entryApp ? `entry ${accepted.id} (${accepted.by})` : `no entry, fallbacks ${JSON.stringify(fallbacks)}`}`);
        this._place(entryApp);
        const look = this._choose(entryApp, fallbacks, host);
        // GNOME's own icon and name both first: as GNOME has it.
        if (look.iconKind === 'default' && look.nameKind === 'default')
            return null;
        if (entryApp) {
            this._setLook(entryApp, look.iconKind === 'desktop' && look.nameKind === 'desktop' ? null : look.whole);
            return entryApp;
        }

        // A launcher's game with no .desktop (Flatpak Bottles can't create
        // one, Heroic doesn't for sideloaded games): still give it its own
        // entry if the order gives it an icon and a name other than the
        // launcher's.
        return look.iconKind !== 'default' && look.nameKind !== 'default'
            ? splitter.virtualApp(look.name, look.gicon, look.tag) : null;
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
        this._patchTitle(win);
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
    // Names are only read when an icon is made (the dock's tooltip, the
    // label under an icon): set them again too. A game that starts through
    // a launcher of its own (THE FINALS: Discovery.exe, "Embark Game
    // Launcher", then Discovery-d.exe) changes name once its own window is
    // up, after the dock made its icon.
    _refreshIcons(apps) {
        if (!apps.size)
            return;
        for (const app of apps)
            app.notify('icon');

        this._notifyTitles(apps);
        const walk = actor => {
            if (apps.has(actor.app)) {
                if (typeof actor.icon?.update === 'function')
                    actor.icon.update();
                actor.icon?.label?.set_text?.(actor.app.get_name());
            }
            // The dash's item around an app icon carries the tooltip.
            if (apps.has(actor.child?.app) && typeof actor.setLabelText === 'function')
                actor.setLabelText(actor.child.app.get_name());
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
