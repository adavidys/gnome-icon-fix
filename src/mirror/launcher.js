// A shortcut mirror for a launcher from Flathub, as its description says
// (launchers.js, mirror):
//
//   shortcuts() -> folders   its own shortcuts, written inside its sandbox
//       where GNOME never looks, and running a binary only the sandbox has:
//       copied with Exec= going through `flatpak run <its app id>`.
//   games(record)            no shortcuts at all (it can't write them from
//       its sandbox): one for each game of its library this accepts, Exec=
//       from exec(record).
//
// Either way the icon is one the host can show (inside its sandbox, its
// game's .exe...), StartupWMClass is wmClass filled in, and the file is
// <prefix><game>.desktop. Only files we generated (prefix + marker key) are
// ever written or removed (base.js).

import GLib from 'gi://GLib';

import {parseExec} from '../lib/appindex.js';
import {exists, findHicolorIcon, listDir, readText, sandboxDir} from '../lib/util.js';
import {fillTemplate} from '../sources/launcher.js';
import {GROUP, MARKER, ShortcutMirror, generatedFiles, removeGenerated} from './base.js';

const encoder = new TextEncoder();

function slug(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

// One argument of an Exec line, quoted as the desktop entry spec wants
// when it has to be.
function quote(arg) {
    return /^[\w./:=@%+,-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

function readKeyFile(data) {
    const kf = new GLib.KeyFile();
    try {
        kf.load_from_bytes(new GLib.Bytes(encoder.encode(data)),
            GLib.KeyFileFlags.KEEP_COMMENTS | GLib.KeyFileFlags.KEEP_TRANSLATIONS);
        return kf;
    } catch {
        return null;
    }
}

function getString(kf, key) {
    try {
        return kf.get_string(GROUP, key);
    } catch {
        return null;
    }
}

export class LauncherMirror extends ShortcutMirror {
    // source: the launcher's (sources/launcher.js)
    constructor(source) {
        const spec = source.desc.mirror;
        super(spec.prefix, spec.iconDir());
        this._source = source;
        this._spec = spec;
        this._flavor = source.sandbox.toLowerCase();
        this.start();
    }

    _watchedDirs() {
        return this._spec.shortcuts?.() ?? this._spec.watch();
    }

    _relevant(dir, file) {
        return !this._spec.relevant || this._spec.watch()[0] === dir || this._spec.relevant.test(file.get_basename());
    }

    _wanted() {
        const wanted = new Map();
        // key: the game, or the parts naming it (a bottle and a program).
        const add = (key, data) => {
            const name = `${this._prefix}${[key].flat().map(slug).join('-')}.desktop`;
            if (!wanted.has(name))
                wanted.set(name, data);
        };
        if (this._spec.shortcuts) {
            for (const dir of this._spec.shortcuts()) {
                for (const name of listDir(dir).filter(n => n.endsWith('.desktop'))) {
                    const out = this.convert(readText(`${dir}/${name}`) ?? '', name);
                    if (out)
                        add(out.key, out.data);
                }
            }
        } else {
            for (const game of this._source.records(this._flavor)) {
                if (game.flavor === this._flavor && this._spec.games(game))
                    add(this._spec.file(game), this.gameShortcut(game));
            }
        }
        return wanted;
    }

    // The host copy of one of the launcher's sandboxed shortcuts: {key,
    // data}, or null if it doesn't run one of its games.
    convert(data, id = '') {
        const kf = readKeyFile(data);
        const exec = kf && getString(kf, 'Exec');
        const argv = parseExec(exec);
        const entry = {id, exec, icon: kf && getString(kf, 'Icon')};
        const fields = exec ? this._source.shortcutFields(entry, argv) : null;
        if (!fields)
            return null;
        // The game as the shortcut names it, for the file name.
        const key = Object.values(this._source.shortcutFields(entry, argv, true))[0];
        kf.set_string(GROUP, 'Exec', ['flatpak', 'run', this._source.sandbox, ...argv.slice(1)].map(quote).join(' '));
        // TryExec= names the binary only the sandbox has: it would hide it.
        try {
            kf.remove_key(GROUP, 'TryExec');
        } catch {}
        const game = this._source.recordOf(fields, this._flavor);
        this._finish(kf, game, fields, entry.icon);
        return {key, data: kf.to_data()[0]};
    }

    // A shortcut for a game of the launcher's library.
    gameShortcut(game) {
        const kf = new GLib.KeyFile();
        kf.set_string(GROUP, 'Type', 'Application');
        kf.set_string(GROUP, 'Name', this._spec.name(game));
        kf.set_string(GROUP, 'Comment', this._spec.comment(game));
        kf.set_string(GROUP, 'Exec', ['flatpak', 'run', ...this._spec.exec(game)].map(quote).join(' '));
        kf.set_string(GROUP, 'Categories', 'Application;');
        this._finish(kf, game, game.fields, null);
        return kf.to_data()[0];
    }

    // What both kinds share: an icon the host can show, the game's name
    // when the launcher knows a better one, the window class, our marker.
    _finish(kf, game, fields, icon) {
        const share = sandboxDir(this._source.sandbox, '.local', 'share');
        const shown = icon?.startsWith('/') && exists(icon) ? icon
            : findHicolorIcon(share, icon) ?? this._source.iconOf(game, fields, {dir: this._iconDir});
        kf.set_string(GROUP, 'Icon', shown ?? this._source.sandbox);
        if (game?.name && this._spec.shortcuts)
            kf.set_string(GROUP, 'Name', game.name);
        const wmClass = fillTemplate(this._spec.wmClass, fields);
        if (wmClass)
            kf.set_string(GROUP, 'StartupWMClass', wmClass);
        kf.set_boolean(GROUP, MARKER, true);
    }
}

// What every mirror's switch in the preferences needs, without starting it.
export function mirrorFiles(spec) {
    return generatedFiles(spec.prefix, spec.iconDir());
}

export function removeMirrored(spec) {
    removeGenerated(spec.prefix, spec.iconDir());
}
