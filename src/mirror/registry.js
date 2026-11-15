// The optional shortcut mirrors: one for each launcher whose description
// has one (launchers.js), each behind a setting of its own. The extension
// starts the ones switched on; the preferences show a group for each, with
// the files it created.
//
//   key: its setting; start(): the running mirror; files(): what it
//   created; iconDir(): where it keeps icons; removeAll(): when switched
//   off; the rest is what the preferences say.

import {LAUNCHERS} from '../launchers.js';
import {LauncherSource} from '../sources/launcher.js';
import {LauncherMirror, mirrorFiles, removeMirrored} from './launcher.js';

export const MIRRORS = LAUNCHERS.filter(desc => desc.mirror).map(desc => {
    const spec = desc.mirror;
    return {
        key: spec.setting,
        title: spec.title,
        description: spec.description,
        switchTitle: spec.switchTitle,
        start: () => new LauncherMirror(new LauncherSource(desc)),
        files: () => mirrorFiles(spec),
        iconDir: spec.iconDir,
        removeAll: () => removeMirrored(spec),
    };
});
