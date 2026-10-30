// GNOME matches every window from a Flatpak sandbox to that sandbox's app,
// whatever StartupWMClass says. For launchers from Flathub that means every
// game shows up as "Steam" (or Heroic, Lutris, Bottles) in the dock and
// Alt+Tab. And a game it can't match at all gets an app made up for its
// window, apart from the game's entry pinned in the dock. The window
// tracker is C code we can't change, so, like Dash to Dock does for its
// file manager locations, we move such windows over in the JS layer
// everything reads from: get_running(), get_window_app() and the
// windows/state/activation of the two apps involved.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as log from './lib/log.js';
import {LAUNCHER_SANDBOXES} from './lib/util.js';

// Gio.DesktopAppInfo moved to GioUnix in newer GLib.
let DesktopAppInfo;
try {
    DesktopAppInfo = (await import('gi://GioUnix')).default.DesktopAppInfo;
} catch {}
DesktopAppInfo ??= Gio.DesktopAppInfo;

// The app info of a game with no .desktop file. Shell's C code reads the
// id, name and icon through these vfuncs (a JS-side get_id override isn't
// seen there, and a NULL id crashes the shell), the same way Dash to Dock
// builds its location apps. A DesktopAppInfo so Shell.App accepts it.
const VirtualAppInfo = GObject.registerClass({
    Implements: [Gio.AppInfo],
}, class VirtualAppInfo extends DesktopAppInfo {
    _init(id, name, icon) {
        super._init();
        this._id = id;
        this._name = name;
        this._icon = icon;
    }

    list_actions() {
        return [];
    }

    get_action_name() {
        return null;
    }

    get_boolean() {
        return false;
    }

    get_string() {
        return null;
    }

    vfunc_dup() {
        return new VirtualAppInfo(this._id, this._name, this._icon);
    }

    vfunc_equal(other) {
        return other?.get_id() === this._id;
    }

    vfunc_get_id() {
        return this._id;
    }

    vfunc_get_name() {
        return this._name;
    }

    vfunc_get_display_name() {
        return this._name;
    }

    vfunc_get_description() {
        return null;
    }

    vfunc_get_executable() {
        return null;
    }

    vfunc_get_commandline() {
        return null;
    }

    vfunc_get_icon() {
        return this._icon;
    }

    // Never launched: it only exists while the game runs, and activating
    // a running app focuses its window.
    vfunc_launch() {
        return false;
    }

    vfunc_launch_uris() {
        return false;
    }

    vfunc_supports_uris() {
        return false;
    }

    vfunc_supports_files() {
        return false;
    }

    vfunc_should_show() {
        return false;
    }

    vfunc_can_delete() {
        return false;
    }
});

// Per-app overrides, installed on the app objects themselves.
const APP_METHODS = [
    'get_windows', 'get_n_windows', 'get_state', 'get_pids', 'is_on_workspace',
    'activate', 'activate_full', 'activate_window',
];

export class WindowSplitter {
    // findApp(win, splitter, host): the Shell.App a window GNOME gave to
    // host (its launcher, or an app made up for it) really belongs to, or
    // null to leave it there.
    constructor(findApp) {
        this._findApp = findApp;
        this._appSystem = Shell.AppSystem.get_default();
        this._tracker = Shell.WindowTracker.get_default();
        // window -> {app, host}
        this._moved = new Map();
        // name and icon -> in-memory app, see virtualApp()
        this._virtual = new Map();
        // Apps we put overrides on -> their own windows (null for hosts:
        // they keep theirs minus the moved ones)
        this._patched = new Map();
        this._refreshId = 0;

        const splitter = this;
        this._injections = new InjectionManager();
        this._injections.overrideMethod(Shell.AppSystem.prototype, 'get_running', original => function () {
            // A launcher whose only windows were games isn't running anymore.
            const running = original.call(this).filter(app =>
                splitter._patched.get(app) !== null || app.get_state() !== Shell.AppState.STOPPED);
            if (!splitter._moved.size)
                return running;
            for (const app of splitter._targets()) {
                if (!running.includes(app))
                    running.push(app);
            }
            // Most recently used first, like GNOME's own order (Alt+Tab
            // relies on it); the moved windows changed who that is.
            const lastUsed = new Map(running.map(app =>
                [app, app.get_windows().reduce((t, w) => Math.max(t, w.get_user_time()), 0)]));
            return running.sort((a, b) => lastUsed.get(b) - lastUsed.get(a));
        });
        this._injections.overrideMethod(Shell.WindowTracker.prototype, 'get_window_app', original => {
            // GNOME's own answer, for _check()
            splitter._gnomeApp = win => original.call(splitter._tracker, win);
            return function (win) {
                return splitter._moved.get(win)?.app ?? original.call(this, win);
            };
        });

        global.display.connectObject('window-created',
            (_display, win) => this._watch(win), this);
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
    }

    destroy() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        global.display.disconnectObject(this);
        for (const win of this._moved.keys())
            win.disconnectObject(this);
        this._injections.clear();

        const apps = [...this._patched.keys()];
        for (const app of apps)
            unpatchApp(app);
        this._moved.clear();
        this._patched.clear();
        this._virtual.clear();
        for (const app of apps)
            this._notify(app);
    }

    // An app for a game that has no .desktop file, built in memory from its
    // name and icon. It never shows up in the app grid; it exists while its
    // windows do. key identifies the name and icon. Returns null if GNOME
    // won't let us build one.
    virtualApp(name, gicon, key) {
        if (this._virtual.has(key))
            return this._virtual.get(key);

        let app = null;
        try {
            const id = `icon-fix-virtual-${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, key, -1).slice(0, 12)}.desktop`;
            app = new Shell.App({app_info: new VirtualAppInfo(id, name, gicon)});
            log.debug(`in-memory app ${id} for "${name}" (${gicon.to_string()})`);
        } catch (e) {
            log.error(`can't create an app for ${name}`, e);
        }
        this._virtual.set(key, app);
        return app;
    }

    // Window class and pid can arrive after window-created; ask again on
    // the first change, and whenever the index behind findApp changes.
    recheckAll() {
        for (const actor of global.get_window_actors())
            this._check(actor.meta_window);
    }

    _watch(win) {
        if (win.is_override_redirect())
            return;
        win.connectObject(
            'notify::wm-class', () => this._check(win),
            'unmanaged', () => this._release(win), this);
        this._check(win);
    }

    _check(win) {
        if (win.is_override_redirect())
            return;
        const current = this._moved.get(win);
        // Asked again each time: GNOME tracks every window anew when the
        // installed apps change, and makes up a new app for an unmatched one.
        const host = this._gnomeApp(win);
        // Already moved there, also when GNOME now gives it the game's
        // entry itself (by its pid, which the entry reports while moved).
        if (current && (host === current.host || host === current.app) &&
            this._findApp(win, this, current.host) === current.app)
            return;
        const app = host && (LAUNCHER_SANDBOXES.has(win.get_sandboxed_app_id()) || host.is_window_backed())
            ? this._findApp(win, this, host) : null;
        if (!app || !host || app === host) {
            if (current)
                this._release(win);
            return;
        }
        // Moved straight on when it was elsewhere (GNOME makes new apps for
        // entries that changed), without going back in between.
        log.debug(`moved window "${win.get_title()}" (${win.get_wm_class()}, pid ${win.get_pid()}) ` +
            `from ${host.get_id()} to ${app.get_id()}`);
        this._moved.set(win, {app, host});
        this._patchHost(host);
        this._patchTarget(app);
        this._queueRefresh();
    }

    _release(win) {
        if (!this._moved.has(win))
            return;
        log.debug(`window "${win.get_title()}" back to the app GNOME gave it (closed or no longer matched)`);
        this._moved.delete(win);
        this._queueRefresh();
    }

    _targets() {
        return new Set([...this._moved.values()].map(m => m.app));
    }

    _patchHost(host) {
        if (this._patched.has(host))
            return;
        this._patched.set(host, null);
        const original = saveOriginals(host);
        patchApp(host, {
            get_windows: () => original.get_windows().filter(w => !this._moved.has(w)),
            get_n_windows: () => host.get_windows().length,
            get_state: () => host.get_n_windows() || original.get_state() !== Shell.AppState.RUNNING
                ? original.get_state() : Shell.AppState.STOPPED,
            activate_window: (win, time) => original.activate_window(win ?? host.get_windows()[0] ?? null, time),
        });
    }

    _patchTarget(app) {
        if (this._patched.has(app))
            return;
        this._patched.set(app, true);
        const original = saveOriginals(app);
        // Its moved windows, and any GNOME gave it itself.
        const own = () => [...new Set([...original.get_windows(),
            ...[...this._moved].filter(([, m]) => m.app === app).map(([w]) => w)])]
            .sort((a, b) => b.get_user_time() - a.get_user_time());
        const running = () => own().length > 0;
        const focus = (win, time) => {
            win ??= own()[0];
            if (!win)
                return;
            const workspace = win.get_workspace();
            if (workspace && workspace !== global.workspace_manager.get_active_workspace())
                workspace.activate_with_focus(win, time || global.get_current_time());
            else
                win.activate(time || global.get_current_time());
        };
        patchApp(app, {
            get_windows: own,
            get_n_windows: () => own().length,
            get_state: () => running() ? Shell.AppState.RUNNING : original.get_state(),
            get_pids: () => [...new Set(own().map(w => w.get_pid()).filter(p => p > 0))],
            is_on_workspace: ws => own().some(w => w.located_on_workspace(ws)) || original.is_on_workspace(ws),
            // Clicking a running game must focus it, not start it again.
            activate: () => running() ? focus(null, 0) : original.activate(),
            activate_full: (ws, time) => running() ? focus(null, time) : original.activate_full(ws, time),
            activate_window: (win, time) => running() ? focus(win, time) : original.activate_window(win, time),
        });
    }

    // Signals go out from an idle: this runs from window-created, where
    // the tracker hasn't finished its own bookkeeping yet.
    _queueRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._refreshId = 0;
            const inUse = new Set([...this._moved.values()].flatMap(m => [m.app, m.host]));
            for (const app of [...this._patched.keys()]) {
                // Done with it: drop the overrides once it is back to normal.
                if (!inUse.has(app)) {
                    unpatchApp(app);
                    this._patched.delete(app);
                }
                this._notify(app);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _notify(app) {
        app.emit('windows-changed');
        app.notify('state');
        this._appSystem.emit('app-state-changed', app);
    }
}

function saveOriginals(app) {
    const original = {};
    for (const name of APP_METHODS)
        original[name] = (...args) => Shell.App.prototype[name].call(app, ...args);
    return original;
}

function patchApp(app, methods) {
    for (const [name, fn] of Object.entries(methods))
        app[name] = fn;
    Object.defineProperty(app, 'state', {
        get: () => app.get_state(),
        configurable: true,
    });
}

function unpatchApp(app) {
    for (const name of APP_METHODS)
        delete app[name];
    delete app.state;
}
