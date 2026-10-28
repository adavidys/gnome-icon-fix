# How GNOME Shell 50 picks a window's app

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

## The preferences window

Open it from Extensions (or `gnome-extensions prefs icon-trace@adavidys`). It shows the log of the **current GNOME Shell session** and follows it live:

- **Windows**: every window with the app GNOME gave it. Expand one for the facts GNOME looked at, each step of the decision (✓ decided, ⊘ found but rejected, – nothing found), and where the name and icon come from and what is drawn. *Snapshot now* records every open window again.
- **Who asks**: every place in the Shell that asked for a window's app, an app's icon or name, grouped by what it asked; expand one for its full JavaScript stack.

## Seeing it

On the debug branch, the **Debug** tab of Icon Fix's preferences shows this for every window of the current session: each step, what GNOME decided, what Icon Fix changed, and every place in the Shell that asked for a window's app or an app's icon or name, with its stack. The trace is written by `src/debug/trace.js` to `~/.cache/icon-fix/debug/trace.jsonl`.

