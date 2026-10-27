// Preferences window: a General page with the optional Flatpak Steam and
// Flatpak Bottles shortcuts and the files each created, and a support page
// with a coin switcher, QR code and copyable address.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as bottlesMirror from './mirror/bottles-flatpak.js';
import * as steamMirror from './mirror/steam-flatpak.js';

// QR codes in qr/ are generated from these addresses (qrencode -l M -m 2).
const COINS = [
    {
        name: 'Bitcoin (BTC)',
        label: 'Bitcoin address',
        address: 'bc1qtp3whjzjep3fmynhe2umtv977nu0cjejuqtk2a',
        network: 'Bitcoin network',
        qr: 'bitcoin.svg',
    },
    {
        name: 'USDT (TRC-20)',
        label: 'Tether USD address',
        address: 'TU4w3fvAd9LhxrU9X64VbXhCB7o4Xhpmkw',
        network: 'Send only USDT on the TRON (TRC-20) network',
        qr: 'usdt.svg',
    },
    {
        name: 'Ethereum (ETH)',
        label: 'Ethereum address',
        address: '0x2eC230b7c62C7A13D9956ACAcdCE369336De8098',
        network: 'Ethereum network (ERC-20)',
        qr: 'ethereum.svg',
    },
];

const QR_SIZE = 220;

// The mirror writes in the Shell's process; let it settle before rereading.
const REFRESH_DELAY_MS = 500;

const CSS = `
.icon-fix-qr {
    background-color: white;
    border-radius: 12px;
    padding: 10px;
}
`;

export default class IconFixPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const provider = new Gtk.CssProvider();
        provider.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(),
            provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        window.set_default_size(520, 640);

        const general = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(general);

        general.add(this._mirrorGroup(window, {
            title: 'Flatpak Steam',
            description: 'Steam from Flathub keeps its game shortcuts inside its sandbox, ' +
                'so GNOME can\'t find them. This copies them to ' +
                '~/.local/share/applications as steam-flatpak-*.desktop files ' +
                'that launch through Flatpak. Your own .desktop files are never touched.',
            key: 'flatpak-steam',
            switchTitle: 'Show Flatpak Steam games',
            mirror: steamMirror,
        }));
        general.add(this._mirrorGroup(window, {
            title: 'Flatpak Bottles',
            description: 'Bottles from Flathub can\'t add its programs to the app grid ' +
                'from its sandbox. This creates a shortcut for each program in your bottles, ' +
                'as bottles-flatpak-*.desktop files in ~/.local/share/applications. ' +
                'Your own .desktop files are never touched.',
            key: 'flatpak-bottles',
            switchTitle: 'Show Flatpak Bottles programs',
            mirror: bottlesMirror,
        }));

        const page = new Adw.PreferencesPage({
            title: 'Support',
            icon_name: 'emblem-favorite-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Support the author',
            description: 'For snacks and Claude Code 🍪',
        });
        page.add(group);

        const coinPicker = new Gtk.DropDown({
            model: Gtk.StringList.new(COINS.map(c => c.name)),
            valign: Gtk.Align.CENTER,
        });
        const methodRow = new Adw.ActionRow({
            title: 'Support via crypto',
            subtitle: 'Preferred method',
            activatable_widget: coinPicker,
        });
        methodRow.add_suffix(coinPicker);
        group.add(methodRow);

        const qrImage = new Gtk.Image({pixel_size: QR_SIZE});
        const qrFrame = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            margin_top: 18,
            margin_bottom: 18,
            css_classes: ['icon-fix-qr'],
        });
        qrFrame.append(qrImage);
        group.add(new Gtk.ListBoxRow({
            child: qrFrame,
            activatable: false,
            selectable: false,
        }));

        const copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy address',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const addressRow = new Adw.ActionRow({
            subtitle_selectable: true,
            subtitle_lines: 2,
            activatable_widget: copyButton,
        });
        addressRow.add_suffix(copyButton);
        group.add(addressRow);

        const networkRow = new Adw.ActionRow({
            title: 'Network',
            css_classes: ['property'],
        });
        networkRow.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
        group.add(networkRow);

        const showCoin = () => {
            const coin = COINS[coinPicker.selected];
            qrImage.gicon = new Gio.FileIcon({
                file: this.dir.get_child('qr').get_child(coin.qr),
            });
            addressRow.title = coin.label;
            addressRow.subtitle = coin.address;
            networkRow.subtitle = coin.network;
        };
        coinPicker.connect('notify::selected', showCoin);
        showCoin();

        copyButton.connect('clicked', () => {
            const coin = COINS[coinPicker.selected];
            window.get_clipboard().set(coin.address);
            window.add_toast(new Adw.Toast({title: `${coin.label} copied`, timeout: 2}));
        });
    }

    // One optional shortcut mirror: its switch and the files it made.
    _mirrorGroup(window, {title, description, key, switchTitle, mirror}) {
        const group = new Adw.PreferencesGroup({title, description});
        const row = new Adw.SwitchRow({
            title: switchTitle,
            subtitle: 'In the app grid and search, with their icons',
        });
        this.getSettings().bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        group.add(this._createdFilesRow(window, mirror));
        return group;
    }

    // Every file one mirror made (and only that mirror), kept up to date
    // while the window is open.
    _createdFilesRow(window, mirror) {
        const expander = new Adw.ExpanderRow({
            title: 'Created files',
            subtitle_lines: 1,
        });
        let rows = [];
        const refresh = () => {
            for (const row of rows)
                expander.remove(row);
            const files = mirror.generatedFiles();
            rows = files.map(file => this._fileRow(window, file));
            for (const row of rows)
                expander.add_row(row);
            const shortcuts = files.filter(f => f.kind === 'shortcut').length;
            const icons = files.length - shortcuts;
            expander.subtitle = files.length
                ? `${plural(shortcuts, 'shortcut')}${icons ? `, ${plural(icons, 'icon')}` : ''}, all removed when switched off`
                : 'None: Icon Fix hasn\'t created any files';
            expander.enable_expansion = files.length > 0;
            if (!files.length)
                expander.expanded = false;
        };
        refresh();

        let timeoutId = 0;
        const queueRefresh = () => {
            if (timeoutId)
                GLib.source_remove(timeoutId);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
                timeoutId = 0;
                refresh();
                return GLib.SOURCE_REMOVE;
            });
        };
        const monitors = [
            GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']),
            mirror.iconDir(),
        ].map(path => {
            try {
                const monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.NONE, null);
                monitor.connect('changed', queueRefresh);
                return monitor;
            } catch {
                return null;
            }
        });
        window.connect('close-request', () => {
            monitors.forEach(m => m?.cancel());
            if (timeoutId)
                GLib.source_remove(timeoutId);
            timeoutId = 0;
            return false;
        });
        return expander;
    }

    _fileRow(window, file) {
        const row = new Adw.ActionRow({
            title: file.kind === 'icon' ? 'Icon taken from a program\'s .exe' : file.name,
            subtitle: file.path,
            subtitle_selectable: true,
            use_markup: false,
        });
        const icon = file.icon?.startsWith('/')
            ? new Gio.FileIcon({file: Gio.File.new_for_path(file.icon)})
            : new Gio.ThemedIcon({name: file.icon ?? 'application-x-executable'});
        row.add_prefix(new Gtk.Image({gicon: icon, pixel_size: 32}));

        const open = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: 'Show in Files',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        open.connect('clicked', () => new Gtk.FileLauncher({file: Gio.File.new_for_path(file.path)})
            .open_containing_folder(window, null, null));
        row.add_suffix(open);
        return row;
    }
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}
