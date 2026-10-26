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

When GNOME can't place a window, Icon Fix finds the matching `.desktop` file the way KDE does:

- **Steam app ID** from `steam_app_N` or the game's environment. This also covers non-Steam shortcuts.
- **Window class**, matched against `StartupWMClass`, `Exec=`, `Icon=` and `Name=`.
- **Process name**, including Wine/Proton `.exe` files.
- **Window title**, as a last resort.

It works with the dock (including Dash to Dock), Alt+Tab and the overview, and has no measurable CPU impact.

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
├── extension.js   # patches app icons/names for unmatched windows
├── matcher.js     # .desktop matching heuristics (no Shell imports, testable with gjs)
├── prefs.js       # preferences window
├── metadata.json
└── qr/            # donation QR codes
```

| Command | What it does |
|---|---|
| `make pack` | Builds `dist/icon-fix@adavidys.shell-extension.zip` for [extensions.gnome.org](https://extensions.gnome.org/upload/) |
| `make install` | Builds and installs the extension for the current user |
| `make uninstall` | Removes it |
| `make clean` | Deletes `dist/` |

## License

[MIT](LICENSE)
