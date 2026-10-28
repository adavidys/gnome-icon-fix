// Debug branch only: the Debug tab of the preferences. Shows the trace
// debug/trace.js writes for the current GNOME Shell session, and follows it
// while the window is open: for each window, the app GNOME gave it, every
// step of that decision and what Icon Fix changed; then every place in the
// Shell that asked for an app's icon or name, or a window's app, with its
// stack.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

// The same paths as debug/trace.js (which can't be imported here: it needs
// GNOME Shell).
const DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'icon-fix', 'debug']);
const LOG = GLib.build_filenamev([DIR, 'trace.jsonl']);
const DUMP = GLib.build_filenamev([DIR, 'dump']);
const REFRESH_DELAY_MS = 300;

const METHODS = {
    get_window_app: 'Which app is this window? (WindowTracker.get_window_app)',
    get_icon: 'App icon (App.get_icon)',
    create_icon_texture: 'App icon widget (App.create_icon_texture)',
    get_name: 'App name (App.get_name)',
};

function readLog() {
    let text = '';
    try {
        text = new TextDecoder().decode(GLib.file_get_contents(LOG)[1]);
    } catch {
        return [];
    }
    const records = [];
    for (const line of text.split('\n')) {
        try {
            if (line)
                records.push(JSON.parse(line));
        } catch {}
    }
    return records;
}

function time(t) {
    return GLib.DateTime.new_from_unix_local(Math.floor(t / 1000)).format('%H:%M:%S');
}

function icon(name, css = [], tooltip = null) {
    return new Gtk.Image({icon_name: name, css_classes: css, valign: Gtk.Align.CENTER, tooltip_text: tooltip});
}

function appIcon(app) {
    try {
        if (app?.shownIcon ?? app?.icon)
            return new Gtk.Image({gicon: Gio.Icon.new_for_string(app.shownIcon ?? app.icon), pixel_size: 32});
    } catch {}
    return new Gtk.Image({icon_name: 'application-x-executable', pixel_size: 32});
}

function label(text, css = []) {
    return new Gtk.Label({
        label: text, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
        selectable: true, css_classes: css,
    });
}

// A row of text inside an expander, for the long parts.
function textRow(text, css = ['monospace']) {
    const box = new Gtk.Box({margin_start: 12, margin_end: 12, margin_top: 8, margin_bottom: 8});
    box.append(label(text, css));
    return new Gtk.ListBoxRow({child: box, activatable: false});
}

// Steps that only explain, without looking anything up.
const NOTES = new Set(['cache', 'transient-for', 'X11 window group']);

function stepIcon(step, decided) {
    if (decided)
        return icon('object-select-symbolic', ['success'], 'Decided');
    if (step.why.startsWith('REJECTED'))
        return icon('action-unavailable-symbolic', ['warning'], 'Found, but GNOME rejected it');
    if (NOTES.has(step.step))
        return icon('dialog-information-symbolic', ['dim-label'], 'Note');
    return icon('window-close-symbolic', ['error'], 'Nothing found');
}

function stepRow(step, decided) {
    const row = new Adw.ActionRow({
        title: GLib.markup_escape_text(step.step, -1),
        subtitle: GLib.markup_escape_text(step.why, -1),
        subtitle_lines: 3,
    });
    row.add_prefix(stepIcon(step, decided));
    if (step.tried !== null && step.tried !== undefined) {
        row.add_suffix(new Gtk.Label({
            label: String(step.tried), ellipsize: Pango.EllipsizeMode.MIDDLE, max_width_chars: 28,
            css_classes: ['monospace', 'dim-label'], tooltip_text: String(step.tried),
        }));
    }
    return row;
}

function windowRow(record, closed) {
    const {window: win, gnome, app, gnomeApp} = record;
    const name = app?.shownName ?? app?.name ?? gnome.decided;
    const fixed = record.moved || (app && (app.shownName !== app.name || app.shownIcon !== app.icon));
    const gnomeName = gnomeApp?.name ?? app?.name ?? gnome.decided;
    const row = new Adw.ExpanderRow({
        title: GLib.markup_escape_text(win.title || win.wmClass || `window ${win.id}`, -1),
        subtitle: GLib.markup_escape_text(`→ ${name}${fixed ? ` (GNOME: ${gnomeName})` : ''} · decided by: ${gnome.by}` +
            `${closed ? ' · closed' : ''}`, -1),
    });
    row.add_prefix(appIcon(app));
    if (fixed)
        row.add_suffix(new Gtk.Label({label: 'Icon Fix', css_classes: ['accent'], tooltip_text: 'Icon Fix changed the app, name or icon GNOME gave'}));
    if (record.agrees === false)
        row.add_suffix(new Gtk.Label({label: 'cached', css_classes: ['warning'], tooltip_text:
            'GNOME kept an older answer for this window than its steps give today'}));

    const facts = [
        `WM_CLASS: ${win.wmClass} (instance ${win.wmInstance})`,
        `sandbox: ${win.sandboxId ?? '—'}   GTK app id: ${win.gtkAppId ?? '—'}   pid: ${win.pid}`,
        `startup id: ${win.startupId ?? '—'}   ${win.clientType}${win.remote ? ', remote' : ''}`,
        `event: ${record.event} at ${time(record.t)}`,
    ];
    row.add_row(textRow(facts.join('\n')));
    for (const step of gnome.steps)
        row.add_row(stepRow(step, step.result && step.result === gnome.decided));
    if (app) {
        const result = [
            `GNOME's app: ${gnome.tracked ?? gnome.decided}${app.id !== (gnome.tracked ?? gnome.decided) ? `   after Icon Fix: ${app.id}` : ''}`,
            app.desktopFile ? `file: ${app.desktopFile}` : 'no .desktop file (window-backed app)',
            `name: ${app.name} ← ${app.nameFrom}`,
            `icon: ${app.icon} ← ${app.iconFrom}`,
            `drawn: ${app.drawn}`,
        ];
        if (app.shownName !== app.name || app.shownIcon !== app.icon)
            result.push(`after Icon Fix: name ${app.shownName}, icon ${app.shownIcon}`);
        row.add_row(textRow(result.join('\n')));
    }
    return row;
}

function callerRow(caller, count) {
    const frame = caller.stack[0] ?? '?';
    const where = frame.replace(/^(.*?)@/, '').replace(/:\d+$/, '');
    const fn = frame.includes('@') ? frame.slice(0, frame.indexOf('@')) : '';
    const what = caller.method === 'get_window_app'
        ? `window "${caller.title}" → ${caller.app}`
        : `${caller.app}${caller.name ? ` → "${caller.name}"` : ''}${caller.gicon ? ` → ${caller.gicon}` : ''}`;
    const row = new Adw.ExpanderRow({
        title: GLib.markup_escape_text(`${where}${fn ? ` (${fn})` : ''}`, -1),
        subtitle: GLib.markup_escape_text(`${what}${count ? ` · ×${count}` : ''} · first at ${time(caller.t)}`, -1),
    });
    row.add_prefix(icon(where.startsWith('ext:') ? 'application-x-addon-symbolic' : 'view-list-bullet-symbolic'));
    row.add_row(textRow(caller.stack.join('\n')));
    return row;
}

// The Debug page; window: the preferences window.
export function debugPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Debug', icon_name: 'utilities-terminal-symbolic'});

    const switchGroup = new Adw.PreferencesGroup();
    const traceRow = new Adw.SwitchRow({
        title: 'Record the trace',
        subtitle: `How GNOME picks each window's app, and who asks for icons. Written to ${LOG}`,
    });
    settings.bind('debug-trace', traceRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    switchGroup.add(traceRow);
    page.add(switchGroup);

    // Groups are rebuilt on every change of the log; rows the user opened
    // stay open.
    let groups = [];
    const expanded = new Set();
    const keep = (row, key) => {
        row.expanded = expanded.has(key);
        row.connect('notify::expanded', () => row.expanded ? expanded.add(key) : expanded.delete(key));
        return row;
    };
    const clear = () => {
        for (const [page, group] of groups)
            page.remove(group);
        groups = [];
    };
    const addGroup = (page, props) => {
        const group = new Adw.PreferencesGroup(props);
        page.add(group);
        groups.push([page, group]);
        return group;
    };

    const refresh = () => {
        clear();
        const records = readLog();
        const start = records.find(r => r.kind === 'enabled');

        const session = addGroup(page, {
            title: 'Current GNOME Shell session',
            description: start
                ? `GNOME Shell ${start.shell ?? ''}, process ${start.shellPid}, traced since ${time(start.t)}. ` +
                  `${records.length} records in ${LOG}`
                : `Nothing recorded yet. Is the debug trace on and Icon Fix enabled? (${LOG})`,
        });
        const dump = new Gtk.Button({label: 'Snapshot now', valign: Gtk.Align.CENTER,
            tooltip_text: 'Ask the Shell to record every open window and running app now'});
        dump.connect('clicked', () => GLib.file_set_contents(DUMP, String(Date.now())));
        const open = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'], tooltip_text: 'Show the log in Files'});
        open.connect('clicked', () => new Gtk.FileLauncher({file: Gio.File.new_for_path(LOG)})
            .open_containing_folder(window, null, null));
        const header = new Gtk.Box({spacing: 6});
        header.append(open);
        header.append(dump);
        session.set_header_suffix(header);

        // The latest record of each window; closed ones after open ones.
        const latest = new Map();
        const closed = new Set();
        for (const r of records) {
            if (r.kind === 'window')
                latest.set(r.window.id, r);
            else if (r.kind === 'window-closed')
                closed.add(r.window);
        }
        const open_ = [...latest.values()].filter(r => !closed.has(r.window.id)).reverse();
        const gone = [...latest.values()].filter(r => closed.has(r.window.id)).reverse();
        if (open_.length) {
            const group = addGroup(page, {title: 'Open windows',
                description: 'How GNOME picked each window\'s app, and so its name and icon. ' +
                    '✓ decided, ⊘ found but rejected, ✗ nothing found, ⓘ a note. ' +
                    '“Icon Fix” marks windows whose app, name or icon Icon Fix changed.'});
            for (const r of open_)
                group.add(keep(windowRow(r, false), `w${r.window.id}`));
        }
        if (gone.length) {
            const group = addGroup(page, {title: 'Closed windows'});
            for (const r of gone)
                group.add(keep(windowRow(r, true), `w${r.window.id}`));
        }

        // Callers, by what they asked; counts from the latest summary.
        const counts = new Map();
        const summary = records.filter(r => r.callers).at(-1)?.callers ?? [];
        for (const c of summary)
            counts.set(`${c.method}\n${c.from}`, c.count);
        const byMethod = new Map();
        for (const r of records.filter(r => r.kind === 'caller')) {
            if (!byMethod.has(r.method))
                byMethod.set(r.method, []);
            byMethod.get(r.method).push(r);
        }
        if (!byMethod.size) {
            addGroup(page, {title: 'No callers recorded yet',
                description: 'Open the overview, Alt+Tab or the dash, then come back.'});
        }
        for (const [method, callers] of byMethod) {
            const group = addGroup(page, {
                title: GLib.markup_escape_text(METHODS[method] ?? method, -1),
                description: `${callers.length} different places in the Shell`,
            });
            for (const c of callers.reverse())
                group.add(keep(callerRow(c, counts.get(`${c.method}\n${c.stack.slice(1, 3).join(' ← ')}`)), `c${c.method}${c.stack.join()}`));
        }
    };
    refresh();

    // Follow the log while the window is open.
    GLib.mkdir_with_parents(DIR, 0o755);
    let timeoutId = 0;
    const monitor = Gio.File.new_for_path(DIR).monitor_directory(Gio.FileMonitorFlags.NONE, null);
    monitor.connect('changed', (_m, file) => {
        if (file.get_path() !== LOG || timeoutId)
            return;
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            timeoutId = 0;
            refresh();
            return GLib.SOURCE_REMOVE;
        });
    });
    window.connect('close-request', () => {
        monitor.cancel();
        if (timeoutId)
            GLib.source_remove(timeoutId);
        return false;
    });
    return page;
}
