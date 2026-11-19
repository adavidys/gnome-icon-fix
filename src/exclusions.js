// The Exclusions page of the preferences: the apps (by their .desktop id)
// and the windows (by their WM_CLASS) Icon Fix leaves exactly as GNOME
// has them: their icon, their name, the app their windows belong to.
// Each is picked from a list (installed apps, open windows) or typed in.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {openWindows} from './debug/page.js';

// Gio.DesktopAppInfo moved to GioUnix in newer GLib.
let DesktopAppInfo;
try {
    DesktopAppInfo = (await import('gi://GioUnix')).default.DesktopAppInfo;
} catch {}
DesktopAppInfo ??= Gio.DesktopAppInfo;

const APPS_KEY = 'blacklist';
const CLASSES_KEY = 'blacklist-wm-classes';

// "org.gnome.Nautilus" or "org.gnome.Nautilus.desktop" -> the latter.
function desktopId(text) {
    const id = text.trim();
    return id.endsWith('.desktop') ? id : `${id}.desktop`;
}

function appInfo(id) {
    try {
        return DesktopAppInfo.new(id);
    } catch {
        return null;
    }
}

function image(gicon, fallback) {
    return new Gtk.Image({gicon: gicon ?? Gio.ThemedIcon.new(fallback), pixel_size: 32, valign: Gtk.Align.CENTER});
}

function escape(text) {
    return GLib.markup_escape_text(text ?? '', -1);
}

// A dialog to pick one of rows ({title, subtitle, gicon, value}), with a
// search; pick(value) gets the chosen one.
function chooser(window, heading, rows, empty, pick) {
    const dialog = new Adw.Dialog({title: heading, content_width: 480, content_height: 560});
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    const search = new Gtk.SearchEntry({placeholder_text: 'Search', margin_start: 12, margin_end: 12, margin_bottom: 6});
    view.add_top_bar(search);

    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'],
        margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 12, valign: Gtk.Align.START});
    const texts = new Map();
    for (const r of rows) {
        const row = new Adw.ActionRow({title: escape(r.title), subtitle: escape(r.subtitle), activatable: true});
        row.add_prefix(image(r.gicon, 'application-x-executable'));
        row.connect('activated', () => {
            pick(r.value);
            dialog.close();
        });
        texts.set(row, `${r.title}\n${r.subtitle}`.toLowerCase());
        list.append(row);
    }
    list.set_filter_func(row => texts.get(row)?.includes(search.text.trim().toLowerCase()) ?? true);
    search.connect('search-changed', () => list.invalidate_filter());

    view.set_content(rows.length
        ? new Gtk.ScrolledWindow({child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER})
        : new Adw.StatusPage({title: empty, icon_name: 'edit-find-symbolic'}));
    dialog.set_child(view);
    dialog.present(window);
    search.grab_focus();
}

// One list of exclusions kept in key: a group with its rows, an entry to
// type one in, and a button that picks one (choose(add)). describe(value,
// seen): {title, subtitle, gicon} of a row; seen: what prepare() gave for
// all the rows at once.
function exclusionGroup(window, settings, {key, title, description, placeholder, normalize, describe, prepare = () => null, chooseLabel, choose}) {
    const group = new Adw.PreferencesGroup({title, description});
    const read = () => [...new Set(settings.get_strv(key))];
    const add = value => {
        const item = normalize(value);
        if (!item)
            return;
        if (read().includes(item)) {
            window.add_toast(new Adw.Toast({title: `${item} is already excluded`, timeout: 2}));
            return;
        }
        settings.set_strv(key, [...read(), item]);
    };

    const pickButton = new Gtk.Button({label: chooseLabel, valign: Gtk.Align.CENTER, css_classes: ['flat']});
    pickButton.connect('clicked', () => choose(add));
    group.set_header_suffix(pickButton);

    const entry = new Adw.EntryRow({title: placeholder, show_apply_button: true});
    entry.connect('apply', () => {
        add(entry.text);
        entry.text = '';
    });
    group.add(entry);

    let rows = [];
    const refresh = () => {
        for (const row of rows)
            group.remove(row);
        const seen = prepare();
        rows = read().sort().map(item => {
            const {title: rowTitle, subtitle, gicon} = describe(item, seen);
            const row = new Adw.ActionRow({title: escape(rowTitle), subtitle: escape(subtitle)});
            row.add_prefix(image(gicon, 'action-unavailable-symbolic'));
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                css_classes: ['flat'], tooltip_text: 'Stop excluding it'});
            remove.connect('clicked', () => settings.set_strv(key, read().filter(i => i !== item)));
            row.add_suffix(remove);
            group.add(row);
            return row;
        });
    };
    const id = settings.connect(`changed::${key}`, refresh);
    window.connect('close-request', () => settings.disconnect(id));
    refresh();
    return group;
}

// The Exclusions page; window: the preferences window.
export function exclusionsPage(window, settings) {
    const page = new Adw.PreferencesPage({title: 'Exclusions', icon_name: 'action-unavailable-symbolic'});

    page.add(exclusionGroup(window, settings, {
        key: APPS_KEY,
        title: 'Applications',
        description: 'Icon Fix leaves these apps as GNOME has them: their icon, their name, and the windows ' +
            'GNOME gives them. A window is not moved to one of them either.',
        placeholder: 'Add by .desktop id (org.gnome.Nautilus.desktop)',
        normalize: text => text.trim() ? desktopId(text) : null,
        describe: id => {
            const info = appInfo(id);
            return info
                ? {title: info.get_display_name(), subtitle: id, gicon: info.get_icon()}
                : {title: id, subtitle: 'Not installed', gicon: null};
        },
        chooseLabel: 'Choose…',
        choose: add => chooser(window, 'Exclude an application',
            Gio.AppInfo.get_all().filter(info => info.get_id() && info.should_show())
                .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()))
                .map(info => ({title: info.get_display_name(), subtitle: info.get_id(),
                    gicon: info.get_icon(), value: info.get_id()})),
            'No applications', add),
    }));

    page.add(exclusionGroup(window, settings, {
        key: CLASSES_KEY,
        title: 'Windows',
        description: 'Windows whose WM_CLASS (its class or its instance, in any case) is listed here keep ' +
            'the app, icon and name GNOME gives them. The Debug tab shows every open window\'s WM_CLASS.',
        placeholder: 'Add by WM_CLASS (steam_app_1091500)',
        normalize: text => text.trim() || null,
        prepare: openWindows,
        describe: (wmClass, open) => {
            const shown = open.filter(r => [r.window.wmClass, r.window.wmInstance]
                .some(c => c?.toLowerCase() === wmClass.toLowerCase()));
            const titles = [...new Set(shown.map(r => r.window.title).filter(Boolean))];
            let gicon = null;
            try {
                const icon = shown[0]?.gnomeApp?.icon ?? shown[0]?.app?.icon;
                gicon = icon ? Gio.Icon.new_for_string(icon) : null;
            } catch {}
            return {title: wmClass, subtitle: titles.length ? `Open: ${titles.join(', ')}` : 'WM_CLASS', gicon};
        },
        chooseLabel: 'Open windows…',
        choose: add => chooser(window, 'Exclude a window',
            openWindows().filter(r => r.window.wmClass || r.window.wmInstance).map(r => {
                let gicon = null;
                try {
                    const icon = r.app?.shownIcon ?? r.app?.icon;
                    gicon = icon ? Gio.Icon.new_for_string(icon) : null;
                } catch {}
                return {title: r.window.title || r.window.wmClass, gicon,
                    subtitle: `WM_CLASS ${r.window.wmClass ?? '—'} (instance ${r.window.wmInstance ?? '—'})`,
                    value: r.window.wmClass ?? r.window.wmInstance};
            }),
            'No open windows seen yet: is Icon Fix enabled?', add),
    }));
    return page;
}
