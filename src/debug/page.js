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

// Gio.DesktopAppInfo moved to GioUnix in newer GLib.
let DesktopAppInfo;
try {
    DesktopAppInfo = (await import('gi://GioUnix')).default.DesktopAppInfo;
} catch {}
DesktopAppInfo ??= Gio.DesktopAppInfo;

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

// Reads the log as it grows: only the lines added since the last call, and
// the whole of it again when it was started over.
class LogReader {
    constructor() {
        this.records = [];
        this._offset = 0;
        this._partial = '';
        this._decoder = new TextDecoder();
    }

    update() {
        let stream;
        try {
            stream = Gio.File.new_for_path(LOG).read(null);
        } catch {
            this._reset();
            return;
        }
        try {
            const size = stream.query_info('standard::size', null).get_size();
            if (size < this._offset)
                this._reset();
            stream.seek(this._offset, GLib.SeekType.SET, null);
            const bytes = stream.read_bytes(size - this._offset, null).toArray();
            this._offset += bytes.length;
            const lines = (this._partial + this._decoder.decode(bytes)).split('\n');
            this._partial = lines.pop();
            for (const line of lines) {
                try {
                    if (line)
                        this.records.push(JSON.parse(line));
                } catch {}
            }
        } finally {
            stream.close(null);
        }
    }

    _reset() {
        this.records = [];
        this._offset = 0;
        this._partial = '';
    }
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
    if (step.result)
        return icon('action-unavailable-symbolic', ['dim-label'], 'GNOME\'s pick, changed by Icon Fix');
    return icon('dialog-information-symbolic', ['dim-label'], 'Note');
}

// Whether a step is worth a row: a note, or one that found an app (used or
// not). Lookups that found nothing are left out.
function shownStep(step) {
    return NOTES.has(step.step) || !!step.result || !!step.candidate || step.why.startsWith('REJECTED');
}

// The app a step found (decided on or rejected): as the trace recorded it,
// else looked up here by the id the step names (older records).
function candidateOf(step) {
    if (step.candidate)
        return step.candidate;
    const id = step.result ?? step.why.match(/^REJECTED (\S+\.desktop):/)?.[1];
    if (!id || id.startsWith('window:'))
        return null;
    let info = null;
    try {
        info = DesktopAppInfo.new(id);
    } catch {}
    return info ? {id, name: info.get_name(), icon: info.get_icon()?.to_string() ?? 'application-x-executable'} : {id, name: id, icon: null};
}

// The icon of the app a step found, faded when it was passed over; an empty
// slot when it found nothing.
function candidateIcon(step, decided) {
    const c = candidateOf(step);
    if (!c)
        return new Gtk.Image({icon_name: 'image-missing-symbolic', pixel_size: 28, opacity: 0.25, valign: Gtk.Align.CENTER, tooltip_text: 'No app found'});
    let gicon = null;
    try {
        gicon = c.icon ? Gio.Icon.new_for_string(c.icon) : null;
    } catch {}
    return new Gtk.Image({
        gicon: gicon ?? Gio.ThemedIcon.new('application-x-executable'), pixel_size: 28, valign: Gtk.Align.CENTER,
        opacity: decided ? 1 : 0.45, tooltip_text: `${c.name} (${c.id})${decided ? '' : ': not used'}`,
    });
}

function stepRow(step, decided) {
    const c = candidateOf(step);
    const row = new Adw.ActionRow({
        title: GLib.markup_escape_text(step.step, -1),
        subtitle: GLib.markup_escape_text(c ? `${c.name} (${c.id}) · ${step.why}` : step.why, -1),
        subtitle_lines: 3,
    });
    // add_prefix() puts each new prefix first: the mark ends up left of
    // the app's icon. Notes don't look anything up: no icon for them.
    if (!NOTES.has(step.step))
        row.add_prefix(candidateIcon(step, decided));
    row.add_prefix(stepIcon(step, decided));
    if (step.tried !== null && step.tried !== undefined) {
        row.add_suffix(new Gtk.Label({
            label: String(step.tried), ellipsize: Pango.EllipsizeMode.MIDDLE, max_width_chars: 28,
            css_classes: ['monospace', 'dim-label'], tooltip_text: String(step.tried),
        }));
    }
    return row;
}

// One name or icon Icon Fix considered (debug/trace.js, extension.js
// _explain()): ★ what the shown name or icon comes from, ⊘ passed over (a
// better source came first), ✗ its icon file is gone.
function candidateRow(c) {
    const used = c.usesIcon || c.usesName;
    const uses = [c.usesName && 'name', c.usesIcon && 'icon'].filter(Boolean).join(' and ');
    const what = [c.name && `"${c.name}"`, c.icon].filter(Boolean).join(' · ') || 'nothing';
    const row = new Adw.ActionRow({
        title: GLib.markup_escape_text(`  ↳ ${c.source}${c.kind === 'entry' ? ` → ${c.id}` : ''}`, -1),
        subtitle: GLib.markup_escape_text(`${what} · ${c.missing ? 'its icon can\'t be shown'
            : used ? `shown: its ${uses}` : 'not used: a source before it gave one'}`, -1),
        subtitle_lines: 3,
    });
    let gicon = null;
    try {
        gicon = c.icon && !c.missing ? Gio.Icon.new_for_string(c.icon) : null;
    } catch {}
    row.add_prefix(new Gtk.Image({gicon: gicon ?? Gio.ThemedIcon.new('image-missing-symbolic'), pixel_size: 28,
        valign: Gtk.Align.CENTER, opacity: used ? 1 : 0.45, tooltip_text: c.icon ?? 'no icon'}));
    row.add_prefix(c.missing ? icon('window-close-symbolic', ['error'], 'Icon file missing')
        : used ? icon('starred-symbolic', ['accent'], 'Icon Fix takes it from here')
            : icon('action-unavailable-symbolic', ['dim-label'], 'Not used'));
    return row;
}

function windowRow(record, closed) {
    const {window: win, gnome, app, gnomeApp} = record;
    const name = app?.shownName ?? app?.name ?? gnome.decided;
    const fixed = record.moved || (app && (app.shownName !== app.name || app.shownIcon !== app.icon));
    const gnomeName = gnomeApp?.name ?? app?.name ?? gnome.decided;
    const row = new Adw.ExpanderRow({
        title: GLib.markup_escape_text(win.title || win.wmClass || `window ${win.id}`, -1),
        subtitle: GLib.markup_escape_text(`window #${win.stableSequence ?? win.id} (${win.wmClass}) → ${name}` +
            `${fixed ? ` (GNOME: ${gnomeName})` : ''} · decided by: ${record.iconFix ? 'Icon Fix' : gnome.by}` +
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
    // One final pick: GNOME's, unless Icon Fix changed it.
    const gnomeWins = !record.iconFix;
    for (const step of gnome.steps.filter(shownStep))
        row.add_row(stepRow(step, gnomeWins && step.result && step.result === gnome.decided));
    if (record.iconFix)
        row.add_row(stepRow(record.iconFix, true));
    for (const c of record.candidates ?? [])
        row.add_row(candidateRow(c));
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

    // Icon Fix traces while this window is open, from now on.
    const reader = new LogReader();
    settings.set_boolean('debug-watching', true);

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
        reader.update();
        const records = reader.records;
        const start = records.find(r => r.kind === 'enabled');

        const session = addGroup(page, {
            title: 'Current GNOME Shell session',
            description: start
                ? `GNOME Shell ${start.shell ?? ''}, process ${start.shellPid}, traced since ${time(start.t)}. ` +
                  `${records.length} records in ${LOG}`
                : `Waiting for GNOME Shell… Is Icon Fix enabled? (${LOG})`,
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

        // The latest record of each window. Open: the windows the Shell last
        // listed as open (older traces: those without a window-closed);
        // every other window is closed.
        const latest = new Map();
        const closed = new Set();
        let openNow = null;
        for (const r of records) {
            if (r.kind === 'window')
                latest.set(r.window.id, r);
            else if (r.kind === 'window-closed')
                closed.add(r.window);
            else if (r.kind === 'open-windows')
                openNow = new Set(r.windows);
        }
        const isOpen = r => openNow ? openNow.has(r.window.id) : !closed.has(r.window.id);
        const byTitle = (a, b) => (a.window.title ?? '').localeCompare(b.window.title ?? '');
        const open_ = [...latest.values()].filter(isOpen).sort(byTitle);
        const gone = [...latest.values()].filter(r => !isOpen(r)).reverse();
        if (open_.length) {
            const group = addGroup(page, {title: 'Open windows',
                description: 'How GNOME picked each window\'s app, and so its name and icon. ' +
                    'Only the steps that found an app are listed: ✓ the final pick, ⊘ found but not used, ⓘ a note; ' +
                    'under Icon Fix, ★ what its name and icon come from and every other candidate (✗ its icon file is missing). ' +
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
        // Icon Fix stops tracing and removes the log.
        settings.set_boolean('debug-watching', false);
        reader.records = [];
        return false;
    });
    return page;
}
