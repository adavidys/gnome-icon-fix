# [Gnome-Icon-Fix](https://extensions.gnome.org/extension/11492/icon-fix/)

**Proper icons for Steam games and other apps in GNOME Shell. No `StartupWMClass` editing required.**

When you launch a Steam game, GNOME often fails to link its window to the game's `.desktop` file. The dock, Alt+Tab and the overview then show a generic placeholder instead of the game's icon:

<img width="537" height="331" alt="Deadlock running with a generic placeholder icon" src="https://github.com/user-attachments/assets/22dddab4-e9af-4165-bee1-0c026a33c3f9" />

The usual fix is to add a line like this to every game's `.desktop` file by hand:

```ini
# ~/.local/share/applications/Deadlock.desktop
StartupWMClass=steam_app_1422450
```

**Icon Fix does this automatically for every game.** It never touches your `.desktop` files:

<img width="1019" height="316" alt="Games with their proper icons in the dock" src="https://github.com/user-attachments/assets/880413e3-6920-4c68-8d76-d70b74ba8a9e" />

## How it works

When GNOME can't place a window, Icon Fix finds the matching `.desktop` file the way KDE does. First it uses what the launcher knows about the game:

| Launcher | How a running game is recognized | Without a shortcut |
|---|---|---|
| **Steam** (native, Flatpak, Snap), **Proton** | `steam_app_N` class, `SteamAppId`/`SteamGameId`, the Proton prefix `compatdata/N`, umu's `GAMEID`, or the game's folder in a Steam library. Covers non-Steam shortcuts. | Steam's icon and the game's name |
| **Heroic** (Epic, GOG, Amazon, sideloaded) | `HEROIC_APP_NAME`, or the install folder from Heroic's `installed.json` | Heroic's icon and the game's title |
| **Lutris** | The game's `exe` and Wine prefix from its Lutris config, or its folder | Lutris' `lutris_<slug>` icon |
| **Bottles** | The program's `.exe` from `bottle.yml` together with `WINEPREFIX`, so two bottles with the same `Launcher.exe` stay apart | The icon Bottles extracted from the `.exe` |
| **Wine** | Menu entries made by Wine itself, matched by `.exe` and prefix, also through the Windows shortcut (`.lnk`) they start | |
| **Snap**, **AppImage**, **Flatpak** | `SNAP_NAME`, `APPIMAGE`, the Flatpak app ID | |

Then, for any app:

- **Window class**, matched against `StartupWMClass`, `Exec=`, `Icon=` and `Name=`.
- **Program**: its path or name, including Wine `.exe` files, behind wrappers such as `gamescope`, `gamemoderun` and `mangohud`.
- **Install folder**: a game started from inside the folder of a shortcut's program or `Path=` (GOG installers, Minigalaxy, itch.io, scripts).
- **Window title**, as a last resort.

It works with the dock (including Dash to Dock), Alt+Tab and the overview, and has no measurable CPU impact: a window's process is looked up once, launcher files are read only for windows GNOME couldn't place and only again after they change, and a changing window title costs a single table lookup.

### Where icons and names come from

The **General** tab of the preferences sets, for windows GNOME can't place by itself, which icon and which name come first. Drag the rows to put them in order; the first one a game has is used:

- **.desktop**: the `Icon=` and `Name=` of the game's `.desktop` file, or, without one, what its launcher knows (Lutris' icon, Heroic's title…)
- **Application**: the icon and product name inside the game's program, a Windows `.exe` (else its file name)
- **Default**: what GNOME shows by itself, the launcher's icon and name or a generic one. Nothing below it is ever used.

The usual order is .desktop, Application, Default. A game whose shortcut was found stays on it in the dock either way, showing the icon and name the order gives while it runs. With Default first for both, Icon Fix leaves such windows as GNOME has them.

### Steam from Flathub

Flatpak Steam (`com.valvesoftware.Steam`) writes its game shortcuts inside its sandbox, where GNOME never looks, and their `Exec=steam …` doesn't exist on the host. So installed games are missing from search and the app grid.

Turn on **Show Flatpak Steam games** in the **Flatpak** tab of the extension's preferences (off by default). Icon Fix then mirrors each game into `~/.local/share/applications/steam-flatpak-<id>.desktop`:

- launches with `flatpak run com.valvesoftware.Steam steam://rungameid/<id>`;
- uses the game's icon from the sandbox;
- sets `StartupWMClass=steam_app_<id>`.

Shortcuts made with **Manage → Add desktop shortcut** (Flatpak Steam keeps them in its sandbox's `Desktop` folder) are mirrored too. For non-Steam games, Steam leaves the icon empty and names them `Game.exe`: the mirror takes the name from Steam's list of non-Steam games without the `.exe`, and the icon you picked in Steam or else the one inside the `.exe` (saved to `~/.local/share/icon-fix/icons`).

The mirror stays in sync as you install or remove games. Icon Fix only writes and deletes files it generated itself; the preferences list every one of them under **Created files**, with a button to show it in Files. Turning the option off removes them.

### Bottles from Flathub

Flatpak Bottles (`com.usebottles.bottles`) can't add its programs to the app grid: its **Add Desktop Entry** reports success but no file appears, because the sandbox may not write to `~/.local/share/applications`.

Turn on **Show Flatpak Bottles programs** in the **Flatpak** tab of the extension's preferences (off by default). Icon Fix then writes a shortcut for every program of every bottle, `~/.local/share/applications/bottles-flatpak-<bottle>-<program>.desktop`:

- launches with `flatpak run --command=bottles-cli com.usebottles.bottles run -p <program> -b <bottle>`, like Bottles' own shortcuts;
- uses the icon Bottles extracted from the program, or else the one inside its `.exe`;
- leaves out programs hidden in Bottles.

Shortcuts follow your bottles as you add and remove programs, and turning the option off removes them. Each option lists the files it created in the preferences, Steam's and Bottles' separately.

### Running games from Flatpak launchers

GNOME assigns every window from a Flatpak sandbox to that sandbox's app, whatever `StartupWMClass` says. So a game started by Steam, Heroic, Lutris or Bottles from Flathub shows up as the launcher itself in the dock and Alt+Tab.

Icon Fix moves such windows to the game's own entry, when it can find one, as Dash to Dock does for its file manager windows. The game then gets its own icon in the dock, Alt+Tab and the overview, and clicking it brings the running game up instead of launching it again. The launcher's own windows stay with the launcher.

Some launchers don't make an entry at all: Flatpak Bottles can't, and Heroic doesn't for sideloaded games. The game then still gets an entry of its own, kept in memory only while it runs, with the name and icon the launcher knows or, for Windows games, the icon inside the `.exe`.

Shortcuts that Flatpak Lutris creates (**Create application menu shortcut**) name an icon that only exists inside Lutris's sandbox. Icon Fix shows it from there instead of a blank icon.

If you added the same game folder to several launchers, each window is matched to the launcher that actually started it.

The native and Flathub versions of a launcher can be installed side by side: a game gets the shortcut of the version that started it (Flatpak shortcuts run `flatpak run <launcher>`, native ones don't), whichever was created first. Native Heroic doesn't mark its games' environment, so its games are recognized by the Wine prefix Heroic set up for them.

### Windows games without an icon

When nothing else knows a Wine game's icon, Icon Fix reads the one stored in its `.exe` (and its product name, if it has one) and caches it as a PNG in `~/.cache/icon-fix`. A Windows shortcut (`.lnk`) a menu entry or launcher points at is followed to the program it starts, or to the icon it names. The game files are only read, never changed. Which `.exe` a game runs comes from the kernel (the files the Wine process has mapped), so it's found even when Proton or umu show it under a drive letter of their own.

A Steam game with no shortcut icon gets the icon Steam shows for it in its library. That one is small, so games that run through Proton keep the sharper icon from their `.exe`.

The same goes for shortcuts with an empty `Icon=` or one that points nowhere: Icon Fix finds the game the shortcut launches (a `.exe` in `Exec`, or the game behind a Steam, Heroic, Lutris or Bottles shortcut) and shows its icon in the app grid, search and dock. Native Linux programs keep no icon inside them, so this only works for Windows games.

## Troubleshooting

The **Debug** tab of the preferences shows, for every open window, how GNOME picked its app, name and icon step by step, what Icon Fix changed, and who in the Shell asks for icons. It's recorded only while the preferences are open.

Icon Fix writes errors to the system journal. Turn on **Debug logging** in the Debug tab of its preferences to also see how each window was matched, which icons were replaced and what the shortcut options wrote:

```bash
journalctl --user -f | grep 'Icon Fix'
```

## Install

**From GNOME Extensions (recommended):** [extensions.gnome.org/extension/11492/icon-fix](https://extensions.gnome.org/extension/11492/icon-fix/)

**From source:**

```bash
git clone https://github.com/adavidys/gnome-icon-fix
cd gnome-icon-fix
make install
```

Log out and back in, then enable it:

```bash
gnome-extensions enable icon-fix@adavidys
```

Supports GNOME Shell 45 to 51.

## Development

```
src/
├── extension.js        # patches app icons/names for unmatched windows, caches results
├── split.js            # moves game windows out of Flatpak launchers' apps
├── debug/              # the Debug tab: trace.js (in the Shell), page.js (preferences)
├── prefs.js            # preferences window
├── lib/                # no Shell imports: runs and tests with plain gjs
│   ├── appindex.js     # lookup tables over the installed .desktop entries
│   ├── matcher.js      # matching order: sources, class, program, folder, title
│   ├── process.js      # /proc reading, argv parsing, Wine path translation
│   ├── formats.js      # YAML (Bottles, Lutris) and VDF (Steam) readers
│   ├── log.js          # journal messages, details behind the debug setting
│   ├── look.js         # the icon and name orders of the preferences
│   ├── lnk.js          # Windows shortcuts (.lnk): the program they start
│   ├── peicon.js       # icon and product name from a Windows .exe
│   └── util.js         # paths, file caches
├── sources/            # one file per launcher, see registry.js for the interface
│   ├── registry.js
│   ├── launcher.js     # what the launchers share: their keys, prefixes, folders
│   ├── steam.js
│   ├── heroic.js
│   ├── lutris.js
│   ├── bottles.js
│   ├── wine.js
│   ├── packaging.js    # Snap, AppImage
│   └── exe.js          # last resort: the .exe's own icon
├── mirror/               # optional shortcuts, each behind its own setting
│   ├── base.js           # watching, writing and cleaning up generated files
│   ├── steam-flatpak.js  # Flatpak Steam's sandboxed shortcuts
│   └── bottles-flatpak.js  # Flatpak Bottles' programs
├── metadata.json
├── schemas/            # GSettings schema
└── qr/                 # donation QR codes
```

To support another launcher, add a file to `sources/` and list it in `sources/registry.js`.

| Command | What it does |
|---|---|
| `make pack` | Builds `dist/icon-fix@adavidys.shell-extension.zip` for [extensions.gnome.org](https://extensions.gnome.org/upload/), replacing the previous one |
| `make install` | Builds and installs the extension for the current user |
| `make schemas` | Compiles the schema in `src/`, needed when `src/` is symlinked into the extensions folder |
| `make uninstall` | Removes it |
| `make clean` | Deletes `dist/` and the compiled schema |
| `make check` | Runs the tests, with code coverage |

## License

[MIT](LICENSE)
