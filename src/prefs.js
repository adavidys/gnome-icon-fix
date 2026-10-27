// Preferences window: a General page with the optional Flatpak Steam
// support, and a support page with a coin switcher, QR code and copyable
// address.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

        const flatpakGroup = new Adw.PreferencesGroup({
            title: 'Flatpak Steam',
            description: 'Steam from Flathub keeps its game shortcuts inside its sandbox, ' +
                'so GNOME can\'t find them. This copies them to ' +
                '~/.local/share/applications as steam-flatpak-*.desktop files ' +
                'that launch through Flatpak. Your own .desktop files are never touched.',
        });
        general.add(flatpakGroup);

        const flatpakRow = new Adw.SwitchRow({
            title: 'Show Flatpak Steam games',
            subtitle: 'In the app grid and search, with their icons',
        });
        this.getSettings().bind('flatpak-steam', flatpakRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        flatpakGroup.add(flatpakRow);

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
}
