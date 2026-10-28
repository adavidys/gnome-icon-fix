// Icon Trace: a debugging extension that shows how GNOME Shell decides
// which app (and so which icon and name) a window gets.
//
// For every window it replays, step by step, what get_app_for_window() in
// GNOME Shell 50's shell-window-tracker.c does, with the public lookups that
// code itself uses, and records which step decided and why the others
// didn't (including matches the tracker rejects). For the app it explains
// where shell-app.c takes the name and the icon from, and whether the icon
// theme can show that icon. It also records every JavaScript caller that
// asks for an app's icon or name or a window's app, with its stack, so it's
// visible who in the Shell (dash, Alt+Tab, overview, an extension) shows
// what.
//
// Output, one JSON object per line: ~/.cache/icon-trace/trace.jsonl (moved
// to trace.jsonl.old past 20 MB). Write anything to ~/.cache/icon-trace/dump
// to get a full dump of all windows and running apps.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'icon-trace']);
const LOG = GLib.build_filenamev([DIR, 'trace.jsonl']);
const DUMP = GLib.build_filenamev([DIR, 'dump']);
const MAX_LOG_BYTES = 20 << 20;
// Frames kept of each caller's stack; the same stack is recorded once,
// then only counted.
const STACK_FRAMES = 8;
// What St.Icon and shell-app.c fall back to.
const FALLBACK_ICON = 'application-x-executable';

const encoder = new TextEncoder();

function write(record) {
    try {
        const file = Gio.File.new_for_path(LOG);
        try {
            if (file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size() > MAX_LOG_BYTES)
                file.move(Gio.File.new_for_path(`${LOG}.old`), Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch {}
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(encoder.encode(`${JSON.stringify({t: Date.now(), ...record})}\n`), null);
        stream.close(null);
    } catch (e) {
        console.error(`Icon Trace: can't write ${LOG}: ${e}`);
    }
}

// The JS stack of whoever called us, without our own frames.
function callers() {
    return (new Error().stack ?? '').split('\n')
        .filter(line => line && !line.includes('/icon-trace@'))
        .slice(0, STACK_FRAMES)
        .map(line => line.replace(/^resource:\/\/\/org\/gnome\/shell\//, '')
            .replace(/@resource:\/\/\/org\/gnome\/shell\//, '@')
            .replace(/@file:\/\/.*\/extensions\//, '@ext:'));
}

// The id GNOME gives a window-backed app (shell-app.c).
function windowBackedId(win) {
    return `window:${win.get_stable_sequence()}`;
}

// Where shell-app.c takes an app's name and icon from, and what St.Icon
// will actually draw for that icon.
function appFacts(app, theme) {
    if (!app)
        return null;
    const info = app.get_app_info();
    const gicon = Shell.App.prototype.get_icon.call(app);
    let drawn;
    if (gicon instanceof Gio.ThemedIcon) {
        const found = gicon.get_names().find(n => theme.has_icon(n));
        drawn = found ? `theme icon ${found}` : `${FALLBACK_ICON} (no theme has ${gicon.get_names().join(', ')})`;
    } else if (gicon instanceof Gio.FileIcon) {
        drawn = gicon.get_file().query_exists(null)
            ? `file ${gicon.get_file().get_path()}` : `${FALLBACK_ICON} (file missing)`;
    } else {
        drawn = gicon ? gicon.to_string() : FALLBACK_ICON;
    }
    const firstWindow = Shell.App.prototype.get_windows.call(app)[0];
    return {
        id: app.get_id(),
        windowBacked: app.is_window_backed(),
        desktopFile: info?.get_filename?.() ?? null,
        name: Shell.App.prototype.get_name.call(app),
        nameFrom: info ? 'Name= of the .desktop file (translated)'
            : firstWindow?.get_wm_class() ? 'WM_CLASS of its window (window-backed app)' : '"Unknown" (window-backed, no WM_CLASS)',
        iconKey: info?.get_string?.('Icon') ?? null,
        icon: gicon?.to_string() ?? null,
        iconFrom: info ? 'Icon= of the .desktop file' : `${FALLBACK_ICON} (window-backed app)`,
        drawn,
        startupWMClass: info?.get_startup_wm_class?.() ?? null,
        // What the Shell UI gets now (extensions such as Icon Fix may
        // change it).
        shownName: app.get_name(),
        shownIcon: app.get_icon()?.to_string() ?? null,
        state: app.state,
    };
}

function windowFacts(win) {
    return {
        id: win.get_id(),
        stableSequence: win.get_stable_sequence(),
        title: win.get_title(),
        wmClass: win.get_wm_class(),
        wmInstance: win.get_wm_class_instance(),
        sandboxId: win.get_sandboxed_app_id(),
        gtkAppId: win.get_gtk_application_id(),
        startupId: win.get_startup_id(),
        pid: win.get_pid(),
        remote: win.is_remote(),
        clientType: win.get_client_type() === Meta.WindowClientType.X11 ? 'x11' : 'wayland',
        windowType: win.get_window_type(),
        transientFor: win.get_transient_for()?.get_id() ?? null,
        skipTaskbar: win.is_skip_taskbar(),
    };
}

// get_app_for_window() of shell-window-tracker.c (GNOME Shell 50), step by
// step, as a fresh decision. Each step: {step, tried, result, why}.
export function replayDecision(win, tracker, appSys, seen = new Set()) {
    const steps = [];
    const add = (step, tried, app, why) => {
        steps.push({step, tried, result: app?.get_id() ?? null, why});
        return app;
    };
    const done = (app, by) => ({steps, decided: app.get_id(), by});

    // 0. A dialog belongs to the app of its parent.
    const parent = win.get_transient_for();
    if (parent && !seen.has(parent)) {
        seen.add(parent);
        add('transient-for', parent.get_id(), null, 'a dialog takes the app of the window it belongs to');
        const parentTrace = replayDecision(parent, tracker, appSys, seen);
        return {steps: [...steps, ...parentTrace.steps], decided: parentTrace.decided, by: `transient-for → ${parentTrace.by}`};
    }

    // Normal and remote windows: the tracker answers from its cache once it
    // has decided (when the window appeared, or its WM_CLASS / GTK app id
    // last changed). The replay below decides afresh.
    if (win.get_window_type() === Meta.WindowType.NORMAL || win.is_remote())
        add('cache', null, null, 'the tracker keeps its first answer for this window; replaying the decision itself');

    // Remote (XDMCP, ssh -X...) windows: always a window-backed app.
    if (win.is_remote()) {
        add('remote window', null, null, 'remote windows always get a window-backed app');
        return {steps, decided: windowBackedId(win), by: 'remote window'};
    }

    // 1. WM_CLASS, but for a sandboxed window only apps whose id starts
    //    with "<sandbox id>." count (check_app_id_prefix()).
    const sandbox = win.get_sandboxed_app_id();
    const prefix = sandbox ? `${sandbox}.` : null;
    const instance = win.get_wm_class_instance();
    const klass = win.get_wm_class();
    const wmClassSteps = [
        ['WM_CLASS instance → StartupWMClass=', instance, () => appSys.lookup_startup_wmclass(instance)],
        ['WM_CLASS class → StartupWMClass=', klass, () => appSys.lookup_startup_wmclass(klass)],
        ['WM_CLASS instance → <name>.desktop', instance, () => appSys.lookup_desktop_wmclass(instance)],
        ['WM_CLASS class → <name>.desktop', klass, () => appSys.lookup_desktop_wmclass(klass)],
    ];
    for (const [step, value, lookup] of wmClassSteps) {
        const app = value ? lookup() : null;
        if (!app) {
            add(step, value, null, value ? 'no such entry' : 'window has none');
        } else if (prefix && !app.get_id().startsWith(prefix)) {
            add(step, value, null, `REJECTED ${app.get_id()}: the window is in the ${sandbox} sandbox and ` +
                `only entries whose id starts with "${prefix}" count`);
        } else {
            add(step, value, app, 'match');
            return done(app, step);
        }
    }

    const byId = (step, id, what) => {
        if (!id)
            return add(step, null, null, `window has no ${what}`);
        const app = appSys.lookup_app(`${id}.desktop`);
        return add(step, `${id}.desktop`, app, app ? 'match' : 'no such entry');
    };

    // 2. Flatpak or Snap app id: "a corresponding .desktop file is
    //    guaranteed" (and so every window of a launcher's sandbox lands
    //    on the launcher).
    let app = byId('sandboxed app id', sandbox, 'sandbox id');
    if (app)
        return done(app, 'sandboxed app id');

    // 3. _GTK_APPLICATION_ID (GApplication).
    app = byId('GTK application id', win.get_gtk_application_id(), 'GApplication id');
    if (app)
        return done(app, 'GTK application id');

    // 4. A running app that already has a window with this pid.
    const pid = win.get_pid();
    app = pid > 0 ? tracker.get_app_from_pid(pid) : null;
    add('pid of a running app', pid, app, pid < 1 ? 'window has no pid'
        : app ? 'a running app has a window with this pid' : 'no running app has this pid');
    if (app)
        return done(app, 'pid of a running app');

    // 5. Startup notification: the launch that opened the window.
    const startupId = win.get_startup_id();
    if (startupId) {
        const sequence = tracker.get_startup_sequences().find(s => s.get_id() === startupId);
        const appId = sequence?.get_application_id();
        app = appId ? appSys.lookup_app(GLib.path_get_basename(appId)) : null;
        add('startup notification', startupId, app,
            !sequence ? 'sequence already gone (it is only kept while the launch is in progress)'
                : !appId ? 'sequence names no app' : app ? `launched as ${appId}` : `${appId} is not an installed app`);
        if (app)
            return done(app, 'startup notification');
    } else {
        add('startup notification', null, null, 'window has no startup id');
    }

    // 6. Another window of its X11 group that has an app (not visible to
    //    JS: MetaGroup isn't introspected).
    add('X11 window group', null, null, win.get_client_type() === Meta.WindowClientType.X11
        ? 'not replayed: MetaGroup is not available to JavaScript' : 'Wayland window: no groups');

    // 7. Last resort.
    add('window-backed app', null, null,
        `GNOME makes an app out of the window itself: name = WM_CLASS, icon = ${FALLBACK_ICON}`);
    return {steps, decided: windowBackedId(win), by: 'window-backed app'};
}

export default class IconTraceExtension extends Extension {
    enable() {
        GLib.mkdir_with_parents(DIR, 0o755);
        this._tracker = Shell.WindowTracker.get_default();
        this._appSys = Shell.AppSystem.get_default();
        this._theme = new St.IconTheme();
        this._stacks = new Map();
        this._idles = new Set();
        this._windows = new Set();
        write({kind: 'enabled', shell: Shell.PACKAGE_VERSION ?? null,
            extensions: global.settings.get_strv('enabled-extensions')});

        // Who asks the Shell for icons, names and window apps, with stacks.
        const ext = this;
        this._injections = new InjectionManager();
        const traceCalls = (proto, method, describe) => {
            this._injections.overrideMethod(proto, method, original => function (...args) {
                const result = original.apply(this, args);
                ext._caller(method, () => describe(this, args, result));
                return result;
            });
        };
        traceCalls(Shell.App.prototype, 'create_icon_texture', (app, [size], icon) =>
            ({app: app.get_id(), size, gicon: icon?.gicon?.to_string?.() ?? null}));
        traceCalls(Shell.App.prototype, 'get_icon', (app, _a, gicon) => ({app: app.get_id(), gicon: gicon?.to_string() ?? null}));
        traceCalls(Shell.App.prototype, 'get_name', (app, _a, name) => ({app: app.get_id(), name}));
        traceCalls(Shell.WindowTracker.prototype, 'get_window_app', (_t, [win], app) =>
            ({window: win?.get_id(), title: win?.get_title(), app: app?.get_id() ?? null}));

        global.display.connectObject('window-created', (_d, win) => {
            this._watch(win);
            // The tracker decides in its own window-created handler; look
            // once everything has settled.
            this._later(() => this._traceWindow('window-created', win));
        }, this);
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window);
        this._appSys.connectObject(
            'app-state-changed', (_s, app) => write({kind: 'app-state-changed', app: app.get_id(), state: app.state}),
            'installed-changed', () => {
                this._theme = new St.IconTheme();
                write({kind: 'installed-changed', note: 'the list of .desktop files changed'});
            }, this);
        this._tracker.connectObject('notify::focus-app', () =>
            write({kind: 'focus-app', app: this._tracker.focus_app?.get_id() ?? null}), this);

        this._monitor = Gio.File.new_for_path(DIR).monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_m, file, _o, event) => {
            if (file.get_path() === DUMP && event === Gio.FileMonitorEvent.CHANGES_DONE_HINT)
                this._dump();
        });
        this._dump();
    }

    disable() {
        for (const id of this._idles)
            GLib.source_remove(id);
        this._idles = null;
        this._injections.clear();
        this._injections = null;
        this._monitor.cancel();
        this._monitor = null;
        global.display.disconnectObject(this);
        for (const win of this._windows)
            win.disconnectObject(this);
        this._windows = null;
        this._appSys.disconnectObject(this);
        this._tracker.disconnectObject(this);
        write({kind: 'disabled', callers: this._callerSummary()});
        this._stacks = null;
        this._tracker = null;
        this._appSys = null;
        this._theme = null;
    }

    _later(fn) {
        const id = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idles.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._idles.add(id);
    }

    // The tracker looks again when one of these changes.
    _watch(win) {
        if (this._windows.has(win))
            return;
        this._windows.add(win);
        win.connectObject(
            'notify::wm-class', () => this._later(() => this._traceWindow('wm-class-changed', win)),
            'notify::gtk-application-id', () => this._later(() => this._traceWindow('gtk-application-id-changed', win)),
            'unmanaged', () => {
                write({kind: 'window-closed', window: win.get_id(), title: win.get_title()});
                win.disconnectObject(this);
                this._windows.delete(win);
            }, this);
    }

    _caller(method, describe) {
        const stack = callers();
        const key = `${method}\n${stack.join('\n')}`;
        const seen = this._stacks.get(key);
        if (seen) {
            seen.count++;
            return;
        }
        this._stacks.set(key, {method, count: 1, stack});
        write({kind: 'caller', method, ...describe(), stack});
    }

    _callerSummary() {
        return [...this._stacks.values()]
            .map(({method, count, stack}) => ({method, count, from: stack.slice(1, 3).join(' ← ')}))
            .sort((a, b) => b.count - a.count);
    }

    _traceWindow(event, win) {
        if (!win.get_display())
            return;
        const replay = replayDecision(win, this._tracker, this._appSys);
        const shown = this._tracker.get_window_app(win);
        write({
            kind: 'window', event,
            window: windowFacts(win),
            gnome: replay,
            app: appFacts(shown, this._theme),
            // false: something (an extension like Icon Fix, or the tracker's
            // cache of an older answer) gives another app than GNOME's own
            // steps would today.
            agrees: replay.decided === shown?.get_id(),
        });
    }

    _dump() {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win.get_window_type() === Meta.WindowType.NORMAL || win.get_transient_for())
                this._traceWindow('dump', win);
        }
        write({
            kind: 'running',
            apps: this._appSys.get_running().map(app => ({...appFacts(app, this._theme),
                windows: app.get_windows().map(w => w.get_id())})),
            callers: this._callerSummary(),
        });
    }
}
