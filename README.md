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
| **Wine** | Menu entries made by Wine itself, matched by `.exe` and prefix | |
| **Snap**, **AppImage**, **Flatpak** | `SNAP_NAME`, `APPIMAGE`, the Flatpak app ID | |

Then, for any app:

- **Window class**, matched against `StartupWMClass`, `Exec=`, `Icon=` and `Name=`.
- **Program**: its path or name, including Wine `.exe` files, behind wrappers such as `gamescope`, `gamemoderun` and `mangohud`.
- **Install folder**: a game started from inside the folder of a shortcut's program or `Path=` (GOG installers, Minigalaxy, itch.io, scripts).
- **Window title**, as a last resort.

It works with the dock (including Dash to Dock), Alt+Tab and the overview, and has no measurable CPU impact: a window's process is looked up once, launcher files are read only for windows GNOME couldn't place and only again after they change, and a changing window title costs a single table lookup.

### Steam from Flathub

Flatpak Steam (`com.valvesoftware.Steam`) writes its game shortcuts inside its sandbox, where GNOME never looks, and their `Exec=steam …` doesn't exist on the host. So installed games are missing from search and the app grid.

Turn on **Show Flatpak Steam games** in the extension's preferences (off by default). Icon Fix then mirrors each game into `~/.local/share/applications/steam-flatpak-<id>.desktop`:

- launches with `flatpak run com.valvesoftware.Steam steam://rungameid/<id>`;
- uses the game's icon from the sandbox;
- sets `StartupWMClass=steam_app_<id>`.

Shortcuts made with **Manage → Add desktop shortcut** (Flatpak Steam keeps them in its sandbox's `Desktop` folder) are mirrored too. For non-Steam games, Steam leaves the icon empty and names them `Game.exe`: the mirror takes the name from Steam's list of non-Steam games without the `.exe`, and the icon you picked in Steam or else the one inside the `.exe` (saved to `~/.local/share/icon-fix/icons`).

The mirror stays in sync as you install or remove games. Icon Fix only writes and deletes files it generated itself. Turning the option off removes them.

### Running games from Flatpak launchers

GNOME assigns every window from a Flatpak sandbox to that sandbox's app, whatever `StartupWMClass` says. So a game started by Steam, Heroic, Lutris or Bottles from Flathub shows up as the launcher itself in the dock and Alt+Tab.

Icon Fix moves such windows to the game's own entry, when it can find one, as Dash to Dock does for its file manager windows. The game then gets its own icon in the dock, Alt+Tab and the overview, and clicking it brings the running game up instead of launching it again. The launcher's own windows stay with the launcher.

Some launchers don't make an entry at all: Flatpak Bottles can't, and Heroic doesn't for sideloaded games. The game then still gets an entry of its own, kept in memory only while it runs, with the name and icon the launcher knows or, for Windows games, the icon inside the `.exe`.

Shortcuts that Flatpak Lutris creates (**Create application menu shortcut**) name an icon that only exists inside Lutris's sandbox. Icon Fix shows it from there instead of a blank icon.

If you added the same game folder to several launchers, each window is matched to the launcher that actually started it.

### Windows games without an icon

When nothing else knows a Wine game's icon, Icon Fix reads the one stored in its `.exe` (and its product name, if it has one) and caches it as a PNG in `~/.cache/icon-fix`. The game files are only read, never changed.

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
├── prefs.js            # preferences window
├── lib/                # no Shell imports: runs and tests with plain gjs
│   ├── appindex.js     # lookup tables over the installed .desktop entries
│   ├── matcher.js      # matching order: sources, class, program, folder, title
│   ├── process.js      # /proc reading, argv parsing, Wine path translation
│   ├── formats.js      # YAML (Bottles, Lutris) and VDF (Steam) readers
│   ├── peicon.js       # icon and product name from a Windows .exe
│   └── util.js         # paths, file caches
├── sources/            # one file per launcher, see registry.js for the interface
│   ├── registry.js
│   ├── steam.js
│   ├── heroic.js
│   ├── lutris.js
│   ├── bottles.js
│   ├── wine.js
│   ├── packaging.js    # Snap, AppImage
│   └── exe.js          # last resort: the .exe's own icon
├── mirror/
│   └── steam-flatpak.js  # optional Flatpak Steam shortcut mirror
├── metadata.json
├── schemas/            # GSettings schema
└── qr/                 # donation QR codes
```

To support another launcher, add a file to `sources/` and list it in `sources/registry.js`.

| Command | What it does |
|---|---|
| `make pack` | Builds `dist/icon-fix@adavidys.shell-extension.zip` for [extensions.gnome.org](https://extensions.gnome.org/upload/) |
| `make install` | Builds and installs the extension for the current user |
| `make schemas` | Compiles the schema in `src/`, needed when `src/` is symlinked into the extensions folder |
| `make uninstall` | Removes it |
| `make clean` | Deletes `dist/` |

## License

[MIT](LICENSE)
