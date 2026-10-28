# Icon Trace (debug)

A separate GNOME Shell extension for debugging, not part of Icon Fix. It records how GNOME Shell decides which app (and so which name and icon) every window gets, and who in the Shell asks for them.

## How GNOME Shell 50 picks a window's app

From `src/shell-window-tracker.c`, `get_app_for_window()`. This runs **once**, when the window appears, and again only when its `WM_CLASS` or GApplication id changes. The answer is stored per window; `shell_window_tracker_get_window_app()` only reads it back.

1. **A dialog** (transient window) takes the app of its parent.
2. **WM_CLASS**, in this order:
   - instance → an entry's `StartupWMClass`;
   - class → `StartupWMClass`;
   - instance → an entry named `<instance>.desktop`;
   - class → `<class>.desktop`.

   **For a window from a Flatpak or Snap sandbox, a match only counts if the entry's id starts with `<sandbox id>.`** (`check_app_id_prefix()`). This is why a game started by Flatpak Steam never gets the game's own entry, even with the right `StartupWMClass`: `steam-flatpak-70.desktop` doesn't start with `com.valvesoftware.Steam.`. An entry named `com.valvesoftware.Steam.<anything>.desktop` would be accepted, the way Flatpak Chromium's web apps (`org.chromium.Chromium.flextop.….desktop`) are.
3. **Sandbox id**: `<sandbox id>.desktop`, "guaranteed to match": the launcher itself.
4. **GApplication id** (`_GTK_APPLICATION_ID`): `<id>.desktop`.
5. **Pid**: a running app that already has a window of this process.
6. **Startup notification**: the launch that opened the window.
7. **X11 window group**: another window of the group (X11 only).
8. **Last resort**: a "window-backed" app. Its name is the `WM_CLASS`, its icon is `application-x-executable` (the generic one): the window's own icon is not used.

When several entries have the same `StartupWMClass`, the one whose id equals the class wins, and entries that are shown win over `NoDisplay` ones; otherwise the first one found.

## Where the icon comes from

`shell_app_create_icon_texture()` (`src/shell-app.c`) makes an `StIcon` whose `gicon` is **bound** to the app's `icon` property, read in C from the entry's `Icon=` (or `application-x-executable` for a window-backed app). A JavaScript override of `ShellApp.get_icon()` is therefore not seen by icons the Shell creates; only an override of `create_icon_texture()` is.

## What it writes

One JSON object per line to `~/.cache/icon-trace/trace.jsonl` (moved to `trace.jsonl.old` past 20 MB):

- **`window`**: when a window appears, when its `WM_CLASS` or GTK application id changes (the only times the tracker decides again), and on a dump.
  - `window`: the facts GNOME looks at: class, instance, sandbox id, GTK app id, startup id, pid, remote, transient-for.
  - `gnome`: `get_app_for_window()` of `shell-window-tracker.c` (GNOME Shell 50), replayed step by step with the same lookups. Each step has what it tried, what it found, and why it didn't decide, including matches the tracker **rejects** (a `WM_CLASS` match outside a window's Flatpak sandbox). `decided` and `by` say which step won.
  - `app`: where `shell-app.c` takes the app's name (`Name=`, else `WM_CLASS`, else "Unknown") and icon (`Icon=`, else `application-x-executable`) from, and what St.Icon will actually draw (`drawn`: the theme icon found, or the fallback and why). `shownName` and `shownIcon` are what the Shell UI gets after extensions such as Icon Fix.
  - `agrees`: false when the window's app differs from what GNOME's own steps give today: an extension changed it, or the tracker kept an older answer.
- **`caller`**: every distinct JavaScript stack that calls `Shell.App.get_icon`, `get_name`, `create_icon_texture` or `WindowTracker.get_window_app`, with the app it got. The same stack is recorded once, then only counted. These show who displays what: the dash, Alt+Tab (`ui/altTab.js`), the overview (`ui/windowPreview.js`), Dash to Dock, other extensions.
- **`running`**: all running apps with the facts above and a summary of the callers (on enable and on every dump).
- `app-state-changed`, `focus-app`, `installed-changed`, `window-closed`, `enabled`, `disabled`.

Write anything to `~/.cache/icon-trace/dump` for a full dump of the current windows.

## Install

```bash
make trace-install
```

Log out and back in, then `gnome-extensions enable icon-trace@adavidys`. Read it, for example:

```bash
tail -f ~/.cache/icon-trace/trace.jsonl | jq -c 'select(.kind == "window") | {title: .window.title, by: .gnome.by, app: .app.id, name: .app.name, drawn: .app.drawn}'
```

## Limits

- The X11 window group step can't be replayed: `MetaGroup` isn't available to JavaScript. It's reported as such.
- C code calling the same functions (for example the tracker's own bookkeeping) doesn't go through JavaScript and isn't in `caller` records.
- Calls are traced only after the extension is enabled; extensions loaded before it may have kept references to the original methods.
