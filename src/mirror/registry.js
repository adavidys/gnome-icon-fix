// The optional shortcut mirrors, each behind a setting of its own. The
// extension starts the ones switched on; the preferences show a group for
// each, with the files it created.
//
//   key: its setting; Mirror: the class (mirror/base.js); module: its
//   generatedFiles() and iconDir(); the rest is what the preferences say.

import * as bottles from './bottles-flatpak.js';
import * as steam from './steam-flatpak.js';

export const MIRRORS = [
    {
        key: 'flatpak-steam',
        Mirror: steam.FlatpakSteamMirror,
        module: steam,
        title: 'Flatpak Steam',
        description: 'Steam from Flathub keeps its game shortcuts inside its sandbox, ' +
            'so GNOME can\'t find them. This copies them to ' +
            '~/.local/share/applications as steam-flatpak-*.desktop files ' +
            'that launch through Flatpak. Your own .desktop files are never touched.',
        switchTitle: 'Show Flatpak Steam games',
    },
    {
        key: 'flatpak-bottles',
        Mirror: bottles.FlatpakBottlesMirror,
        module: bottles,
        title: 'Flatpak Bottles',
        description: 'Bottles from Flathub can\'t add its programs to the app grid ' +
            'from its sandbox. This creates a shortcut for each program in your bottles, ' +
            'as bottles-flatpak-*.desktop files in ~/.local/share/applications. ' +
            'Your own .desktop files are never touched.',
        switchTitle: 'Show Flatpak Bottles programs',
    },
];
