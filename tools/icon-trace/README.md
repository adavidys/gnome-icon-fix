# Icon Trace (debug)

A separate GNOME Shell extension for debugging, not part of Icon Fix. It records how GNOME Shell decides which app (and so which name and icon) a window gets, and who in the Shell asks for them.

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
