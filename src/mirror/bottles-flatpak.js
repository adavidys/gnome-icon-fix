// Bottles from Flathub can't add its programs to the app grid: the portal
// refuses its shortcuts and it may not write to ~/.local/share/applications
// itself, though it reports success. When enabled, we write one shortcut
// per program of every bottle, as bottles-flatpak-<bottle>-<program>.desktop,
// running it the way Bottles' own shortcuts do and showing the icon Bottles
// took from the .exe (or one we take). Only files we generated (prefix +
// marker key) are ever written or removed.

import GLib from 'gi://GLib';

import {parseYaml} from '../lib/formats.js';
import * as log from '../lib/log.js';
import {exeInfo} from '../lib/peicon.js';
import {exeStem, exists, listDir, readText} from '../lib/util.js';
import {bottleFromConfig} from '../sources/bottles.js';
import {GROUP, MARKER, ShortcutMirror, generatedFiles as filesOf, removeGenerated} from './base.js';

const BOTTLES_APP = 'com.usebottles.bottles';
const PREFIX = 'bottles-flatpak-';

function bottlesDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.var', 'app', BOTTLES_APP, 'data', 'bottles', 'bottles']);
}

// Icons taken from programs' .exe files when Bottles has none.
export function iconDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'icon-fix', 'bottles-icons']);
}

function slug(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
}

// One argument of an Exec line, quoted as the desktop entry spec wants.
function quote(arg) {
    return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

// The .desktop contents for one program of a bottle.
// bottle: {dir, name, programs} (sources/bottles.js), program: one of them.
export function programShortcut(bottle, program, icons = iconDir()) {
    const ref = bottle.name ?? GLib.path_get_basename(bottle.dir);
    const kf = new GLib.KeyFile();
    kf.set_string(GROUP, 'Type', 'Application');
    kf.set_string(GROUP, 'Name', program.name);
    kf.set_string(GROUP, 'Comment', `Run in Bottles (${ref})`);
    kf.set_string(GROUP, 'Exec', [
        'flatpak', 'run', '--command=bottles-cli', BOTTLES_APP, 'run', '-p', quote(program.name), '-b', quote(ref),
    ].join(' '));
    const extracted = `${bottle.dir}/icons/${program.name}.png`;
    const icon = exists(extracted) ? extracted
        : program.path && exists(program.path) ? exeInfo(program.path, icons)?.icon ?? null : null;
    kf.set_string(GROUP, 'Icon', icon ?? BOTTLES_APP);
    kf.set_string(GROUP, 'Categories', 'Application;');
    // What Bottles' own shortcuts set: Wine names the window after the .exe.
    kf.set_string(GROUP, 'StartupWMClass', exeStem(program.path ?? program.name));
    kf.set_boolean(GROUP, MARKER, true);
    return kf.to_data()[0];
}

export class FlatpakBottlesMirror extends ShortcutMirror {
    constructor() {
        super(PREFIX, iconDir());
        this.start();
    }

    // The bottles folder (bottles come and go) and each bottle (its
    // bottle.yml is rewritten when programs change).
    _watchedDirs() {
        const root = bottlesDir();
        return [root, ...listDir(root).map(name => GLib.build_filenamev([root, name]))];
    }

    // A running program makes Wine rewrite its bottle's registry files every
    // few seconds; only bottle.yml and the extracted icons matter.
    _relevant(dir, file) {
        return dir === bottlesDir() || /^(bottle\.yml|icons)$/.test(file.get_basename());
    }

    _wanted() {
        const wanted = new Map();
        const root = bottlesDir();
        for (const folder of listDir(root)) {
            const dir = GLib.build_filenamev([root, folder]);
            const text = readText(GLib.build_filenamev([dir, 'bottle.yml']));
            if (text === null)
                continue;
            let bottle;
            try {
                bottle = {dir, ...bottleFromConfig(parseYaml(text))};
            } catch (e) {
                log.warn(`can't read ${dir}/bottle.yml: ${e}`);
                continue;
            }
            for (const program of bottle.programs.filter(p => !p.removed)) {
                const name = `${PREFIX}${slug(folder)}-${slug(program.name)}.desktop`;
                if (!wanted.has(name))
                    wanted.set(name, programShortcut(bottle, program));
            }
        }
        return wanted;
    }

    static removeAll() {
        removeGenerated(PREFIX, iconDir());
    }
}

// The files this mirror made, for the preferences window.
export function generatedFiles() {
    return filesOf(PREFIX, iconDir());
}
