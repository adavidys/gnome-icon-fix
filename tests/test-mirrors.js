import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {GAME_EXE, HOME, eq, ok, short, test} from './harness.js';
import {MARKER, ShortcutMirror, applicationsDir, generatedFiles as filesOf, isGenerated, removeGenerated} from '../src/mirror/base.js';
import * as bottles from '../src/mirror/bottles-flatpak.js';
import * as steam from '../src/mirror/steam-flatpak.js';

ShortcutMirror.syncDelayMs = 30;
ShortcutMirror.waitSeconds = 1;

const APPS = `${HOME}/.local/share/applications`;
const STEAM = `${HOME}/.var/app/com.valvesoftware.Steam`;
const read = path => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
};
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

// Runs the main loop until cond() holds (or ms pass); returns cond().
function waitFor(cond, ms = 4000) {
    const loop = new GLib.MainLoop(null, false);
    const start = Date.now();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        if (cond() || Date.now() - start > ms) {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
    loop.run();
    return cond();
}

test('mirror: Flatpak Steam shortcuts converted for the host', () => {
    const share = `${STEAM}/.local/share`;
    const convert = (data, nonSteam) => steam.convertShortcut(share, data, nonSteam);
    eq(convert('not a key file'), null);
    eq(convert('[Desktop Entry]\nName=x\n'), null, 'no Exec');
    eq(convert('[Desktop Entry]\nName=x\nExec=steam steam://open/news\n'), null);
    const game = convert('[Desktop Entry]\n# a comment\nName=Half-Life\nName[ru]=Халф-Лайф\nExec=steam steam://rungameid/70\nTryExec=steam\nIcon=steam_icon_70\n');
    eq(game.gameId, '70');
    ok(game.data.includes('Exec=flatpak run com.valvesoftware.Steam steam://rungameid/70\n'));
    ok(game.data.includes('StartupWMClass=steam_app_70\n'));
    ok(game.data.includes(`Icon=${share}/icons/hicolor/32x32/apps/steam_icon_70.png\n`));
    ok(game.data.includes('Name[ru]=Халф-Лайф') && game.data.includes('# a comment'), 'translations and comments kept');
    ok(!game.data.includes('TryExec') && game.data.includes(`${MARKER}=true`));
    eq(convert('[Desktop Entry]\nExec=steam steam://rungameid/70\nIcon=/nope.png\n').data.includes('Icon=/nope.png'), true, 'a missing icon file stays as is');
    eq(convert(`[Desktop Entry]\nExec=steam steam://rungameid/70\nIcon=${HOME}/custom-icon.png\n`).data.includes(`Icon=${HOME}/custom-icon.png`), true);
    ok(!convert('[Desktop Entry]\nExec=steam steam://rungameid/70\n').data.includes('Icon='), 'no Icon key');
    const nonSteam = convert('[Desktop Entry]\nName=Game.exe\nExec=steam steam://rungameid/9606503357577428992\nIcon=\n',
        id => id === '2236688360' ? {name: 'Game', icon: '/icon.png'} : null);
    eq(nonSteam.gameId, '9606503357577428992');
    ok(nonSteam.data.includes('Name=Game\n') && nonSteam.data.includes('Icon=/icon.png\n') && !nonSteam.data.includes('StartupWMClass'));
    const unknown = convert('[Desktop Entry]\nName=Game.exe\nExec=steam steam://rungameid/9606503357577428992\n', () => null);
    ok(unknown.data.includes('Name=Game.exe\n'), 'nothing known: left as Steam named it');
    ok(convert('[Desktop Entry]\nName=Game.exe\nExec=steam steam://rungameid/9606503357577428992\n').data.includes('Name=Game.exe'), 'default lookup');
});

test('mirror: Flatpak Steam mirror writes, keeps and removes its files', () => {
    const half = `${APPS}/steam-flatpak-70.desktop`;
    const some = `${APPS}/steam-flatpak-9606503357577428992.desktop`;
    // A file of the same name that Icon Fix didn't create is left alone.
    GLib.mkdir_with_parents(APPS, 0o755);
    GLib.file_set_contents(half, '[Desktop Entry]\nName=Mine\n');
    const mirror = new steam.FlatpakSteamMirror();
    try {
        eq(read(half), '[Desktop Entry]\nName=Mine\n');
        ok(read(some).includes('Name=Some Game\n') && read(some).includes(`Icon=${HOME}/custom-icon.png\n`), 'from shortcuts.vdf');
        GLib.unlink(half);
        mirror.sync();
        ok(read(half).includes('Name=Half-Life'), 'written once free');
        const before = read(half);
        mirror.sync();
        eq(read(half), before, 'unchanged');

        // No picked icon: the one in the .exe, kept in the mirror's folder.
        GLib.rename(`${HOME}/custom-icon.png`, `${HOME}/custom-icon.off`);
        mirror.sync();
        const icon = read(some).match(/^Icon=(.*)$/m)[1];
        ok(icon.startsWith(steam.iconDir()) && exists(icon), icon);
        eq(filesOf('steam-flatpak-', steam.iconDir()).map(f => f.kind).sort(), ['icon', 'shortcut', 'shortcut', 'shortcut']);
        eq(steam.generatedFiles().length, 4);
        ok(read(`${APPS}/steam-flatpak-53021404823552.desktop`).includes('Name=Gone.exe\n'), 'unknown to shortcuts.vdf: as Steam named it');
        // The icon is picked again: the .exe's copy goes away.
        GLib.rename(`${HOME}/custom-icon.off`, `${HOME}/custom-icon.png`);
        mirror.sync();
        ok(!exists(icon), 'unused icon removed');

        // A generated shortcut nothing asks for anymore is removed; others' aren't.
        const stale = `${APPS}/steam-flatpak-123.desktop`;
        GLib.file_set_contents(stale, `[Desktop Entry]\nName=Old\n${MARKER}=true\n`);
        GLib.file_set_contents(`${APPS}/steam-flatpak-456.desktop`, '[Desktop Entry]\nName=Not ours\n');
        mirror.sync();
        ok(!exists(stale) && exists(`${APPS}/steam-flatpak-456.desktop`));

        // Steam adds a shortcut: mirrored after a short pause.
        GLib.file_set_contents(`${STEAM}/.local/share/applications/CS.desktop`,
            '[Desktop Entry]\nName=CS\nExec=steam steam://rungameid/80\nIcon=steam_icon_80\n');
        ok(waitFor(() => exists(`${APPS}/steam-flatpak-80.desktop`)), 'mirrored on change');
        GLib.unlink(`${STEAM}/.local/share/applications/CS.desktop`);
        ok(waitFor(() => !exists(`${APPS}/steam-flatpak-80.desktop`)), 'removed on change');

        // Unreadable and unrelated files are skipped.
        const locked = `${STEAM}/.local/share/applications/locked.desktop`;
        GLib.file_set_contents(locked, '[Desktop Entry]\nExec=steam steam://rungameid/90\n');
        GLib.chmod(locked, 0);
        GLib.file_set_contents(`${APPS}/other.desktop`, '[Desktop Entry]\n');
        GLib.file_set_contents(`${APPS}/steam-flatpak-notes.txt`, 'x');
        GLib.file_set_contents(`${APPS}/steam-flatpak-locked.desktop`, `${MARKER}=true\n`);
        GLib.chmod(`${APPS}/steam-flatpak-locked.desktop`, 0);
        mirror.sync();
        ok(!exists(`${APPS}/steam-flatpak-90.desktop`) && exists(`${APPS}/steam-flatpak-locked.desktop`));
        eq(steam.generatedFiles().filter(f => f.kind === 'shortcut').length, 3, 'only readable files of ours');
        for (const f of [locked, `${APPS}/other.desktop`, `${APPS}/steam-flatpak-notes.txt`, `${APPS}/steam-flatpak-locked.desktop`]) {
            GLib.chmod(f, 0o644);
            GLib.unlink(f);
        }

        // Steam's Desktop folder goes away and comes back.
        const desktop = `${STEAM}/Desktop`;
        GLib.rename(desktop, `${desktop}.off`);
        ok(waitFor(() => mirror._waits.has(desktop)), 'waiting for it');
        ok(waitFor(() => !exists(some)), 'its shortcut removed');
        waitFor(() => false, 2600);
        ok(mirror._waits.has(desktop), 'still waiting while it is missing');
        GLib.rename(`${desktop}.off`, desktop);
        ok(waitFor(() => mirror._monitors.has(desktop) && exists(some), 3000), 'watched again');
    } finally {
        mirror._queueSync();
        mirror._queueSync();
        mirror.destroy();
        GLib.unlink(`${APPS}/steam-flatpak-456.desktop`);
    }
    steam.FlatpakSteamMirror.removeAll();
    eq(steam.generatedFiles(), []);
});

test('mirror: Flatpak Bottles shortcuts', () => {
    const bottle = {dir: `${HOME}/b/Odd "Bottle"`, name: null, programs: []};
    const name = 'Say "Hi" $now `x` \\ back';
    const odd = bottles.programShortcut(bottle, {name, path: null}, `${HOME}/bicons`);
    // Exec as GLib reads it back: the exact name and bottle.
    const kf = new GLib.KeyFile();
    kf.load_from_bytes(new GLib.Bytes(new TextEncoder().encode(odd)), GLib.KeyFileFlags.NONE);
    eq(GLib.shell_parse_argv(kf.get_string('Desktop Entry', 'Exec'))[1],
        ['flatpak', 'run', '--command=bottles-cli', 'com.usebottles.bottles', 'run', '-p', name, '-b', 'Odd "Bottle"']);
    eq(kf.get_string('Desktop Entry', 'Name'), name);
    ok(odd.includes('Icon=com.usebottles.bottles\n') && !odd.includes('StartupWMClass'), 'no .exe, no window class');
    const fromExe = bottles.programShortcut({dir: `${HOME}/b`, name: 'B', programs: []}, {name: 'G', path: GAME_EXE}, `${HOME}/bicons`);
    ok(fromExe.includes(`Icon=${HOME}/bicons/`) && fromExe.includes('StartupWMClass=some game\n'), fromExe);
    eq(bottles.programShortcut({dir: `${HOME}/b`, name: 'B', programs: []}, {name: 'G', path: `${HOME}/missing.exe`}).includes('Icon=com.usebottles.bottles'), true);

    const root = `${HOME}/.var/app/com.usebottles.bottles/data/bottles/bottles`;
    // Two programs whose names give the same file name, and one without any.
    GLib.mkdir_with_parents(`${root}/Dupes`, 0o755);
    GLib.file_set_contents(`${root}/Dupes/bottle.yml`,
        `Name: Dupes\nExternal_Programs:\n  a:\n    name: Some-Game\n    path: ${GAME_EXE}\n  b:\n    name: Some Game\n    path: ${GAME_EXE}\n  c:\n    name: '!!!'\n    path: ${GAME_EXE}\n`);
    const mirror = new bottles.FlatpakBottlesMirror();
    try {
        const names = bottles.generatedFiles().filter(f => f.kind === 'shortcut').map(f => f.path.split('/').pop()).sort();
        eq(names, [
            'bottles-flatpak-dupes-some-game.desktop', 'bottles-flatpak-dupes-x.desktop',
            'bottles-flatpak-somebottle-broken.desktop', 'bottles-flatpak-somebottle-rel.desktop',
            'bottles-flatpak-somebottle-some-game.desktop', 'bottles-flatpak-somebottle-tool-pro-co.desktop',
        ]);
        ok(read(`${APPS}/bottles-flatpak-dupes-some-game.desktop`).includes('Name=Some-Game\n'), 'the first one wins');
        ok(read(`${APPS}/bottles-flatpak-somebottle-some-game.desktop`).includes(`Icon=${root}/SomeBottle/icons/Some Game.png`));
        ok(mirror._monitors.has(`${root}/SomeBottle`) && mirror._monitors.has(root), 'the bottles and each bottle');
        eq(mirror._relevant(root, Gio.File.new_for_path(`${root}/New`)), true);
        eq(mirror._relevant(`${root}/SomeBottle`, Gio.File.new_for_path(`${root}/SomeBottle/bottle.yml`)), true);
        eq(mirror._relevant(`${root}/SomeBottle`, Gio.File.new_for_path(`${root}/SomeBottle/icons`)), true);
        eq(mirror._relevant(`${root}/SomeBottle`, Gio.File.new_for_path(`${root}/SomeBottle/user.reg`)), false);
        // Wine writing its registry doesn't resync; a program removed does.
        GLib.file_set_contents(`${root}/Dupes/user.reg`, 'x');
        GLib.file_set_contents(`${root}/Dupes/bottle.yml`, 'Name: Dupes\n');
        ok(waitFor(() => !exists(`${APPS}/bottles-flatpak-dupes-x.desktop`)), 'removed with its program');
        // A bottle goes away: it's no longer watched.
        GLib.unlink(`${root}/Dupes/bottle.yml`);
        GLib.unlink(`${root}/Dupes/user.reg`);
        GLib.rmdir(`${root}/Dupes`);
        ok(waitFor(() => !mirror._monitors.has(`${root}/Dupes`) && !mirror._waits.has(`${root}/Dupes`)), 'no longer watched');
    } finally {
        mirror.destroy();
    }
    bottles.FlatpakBottlesMirror.removeAll();
    eq(bottles.generatedFiles(), []);
});

test('mirror: base class defaults and failures', () => {
    const icons = `${HOME}/base-icons`;
    eq(applicationsDir(), APPS);
    eq(isGenerated(`x\n${MARKER}=true\n`), true);
    eq(isGenerated('x'), false);

    const plain = new ShortcutMirror('base-test-', icons);
    eq(plain._watchedDirs(), []);
    eq(plain._wanted().size, 0);
    eq(plain._relevant('a', null), true);
    plain.start();
    plain.destroy();

    class Failing extends ShortcutMirror {
        constructor(wanted) {
            super('base-test-', icons);
            this.wanted = wanted;
        }

        _wanted() {
            if (!this.wanted)
                throw new Error('cannot read the launcher');
            return this.wanted;
        }
    }
    const ours = `${APPS}/base-test-a.desktop`;
    GLib.file_set_contents(ours, `[Desktop Entry]\n${MARKER}=true\n`);
    new Failing(null).sync();
    ok(exists(ours), 'a read error keeps what is there');
    // Can't write: a warning, the rest goes on.
    GLib.chmod(APPS, 0o555);
    new Failing(new Map([['base-test-b.desktop', `[Desktop Entry]\n${MARKER}=true\n`]])).sync();
    GLib.chmod(APPS, 0o755);
    ok(!exists(`${APPS}/base-test-b.desktop`));
    removeGenerated('base-test-', icons);
    ok(!exists(ours));
    eq(short(filesOf('base-test-', icons).map(f => f.path)), []);
});
