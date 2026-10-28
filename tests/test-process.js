import GLib from 'gi://GLib';

import {GAME_DIR, GAME_EXE, HOME, eq, ok, test} from './harness.js';
import * as process from '../src/lib/process.js';

const MAPPER = 'import mmap,sys,time; f=open(sys.argv[1],"rb"); m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ); time.sleep(30)';

// Starts a process that maps a file like Wine maps a game's .exe; returns
// its pid (or that of its descendant that has it, under bwrap) once the
// mapping is there.
export function spawnMapper(argv, envp = null, cwd = null) {
    const [, pid] = GLib.spawn_async(cwd, argv, envp, GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
    const read = path => {
        try {
            return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
        } catch {
            return '';
        }
    };
    const family = p => [p, ...read(`/proc/${p}/task/${p}/children`).split(' ').filter(Boolean).flatMap(family)];
    for (let i = 0; i < 50; i++) {
        const mapper = family(pid).find(p => /\.exe$/m.test(read(`/proc/${p}/maps`)));
        if (mapper)
            return Number(mapper);
        GLib.usleep(100000);
    }
    throw new Error(`nothing mapped a .exe: ${argv.join(' ')}`);
}

export function kill(pid) {
    GLib.spawn_command_line_sync(`kill ${pid}`);
}

test('process: programFromArgv skips launchers and wrappers', () => {
    const p = process.programFromArgv;
    eq(p([]), null);
    eq(p(['env', 'A=1', '/usr/bin/game', '--x']), {path: '/usr/bin/game'});
    eq(p(['flatpak', 'run', '--branch=stable', 'Org.Foo.Bar', 'x']), {flatpak: 'org.foo.bar'});
    eq(p(['flatpak', 'run']), null);
    eq(p(['flatpak', 'info', 'x']), {path: 'info'});
    eq(p(['wine', 'start', '/unix', '/g/Game.exe']), {path: '/g/Game.exe'});
    eq(p(['C:\\windows\\system32\\start.exe', '/wait', '/unix', '/g/Game.exe']), {path: '/g/Game.exe'});
    eq(p(['start', 'x']), {path: 'start'}, '"start" alone is a program');
    eq(p(['wine', 'start']), null, 'start with nothing after it');
    eq(p(['gamescope', '-w', '1920', '--', 'mangohud', '%command%']), {path: '%command%'});
    eq(p(['gamescope', '-f']), null);
    eq(p(['steam', 'steam://rungameid/70']), null);
    eq(p(['xdg-open', 'heroic://launch/x', '1234', '']), null);
});

test('process: Wine binaries and paths', () => {
    eq(process.isWineBinary('/usr/bin/wine64-preloader'), true);
    eq(process.isWineBinary('/usr/bin/winecfg'), false);
    eq(process.isWineProcess({exe: '/x/wine-preloader', argv: []}), true);
    eq(process.isWineProcess({exe: null, argv: ['C:\\x\\Game.EXE']}), true);
    eq(process.isWineProcess({exe: null, argv: []}), false);
    const prefix = `${HOME}/.wine-game`;
    eq(process.wineToHost('/unix/path/./x', prefix), '/unix/path/x');
    eq(process.wineToHost('Z:\\var\\x\\G.exe', null), '/var/x/G.exe');
    eq(process.wineToHost('C:\\Game\\game.exe', null), null, 'no prefix');
    eq(process.wineToHost('C:\\Game\\game.exe', prefix), `${prefix}/drive_c/Game/game.exe`);
    eq(process.wineToHost('d:/other.exe', prefix), `${HOME}/Elsewhere/other.exe`);
    eq(process.wineToHost('Q:\\x', prefix), null, 'unmapped drive');
    eq(process.winePrefixOf({env: {WINEPREFIX: `${prefix}/`}}, false), prefix);
    eq(process.winePrefixOf({env: {}}, true), `${HOME}/.wine`);
    eq(process.winePrefixOf({env: {}}, false), null);
});

test('process: readProcess reads argv, links and wanted variables', () => {
    eq(process.readProcess(0, new Set()), {pid: 0, argv: [], exe: null, cwd: null, env: {}});
    const envp = ['WANTED=yes', 'OTHER=no', 'BROKEN', `PATH=${GLib.getenv('PATH')}`];
    const pid = spawnMapper(['python3', '-c', MAPPER, GAME_EXE], envp, GAME_DIR);
    try {
        const info = process.readProcess(pid, new Set(['WANTED']));
        eq(info.argv.slice(1, 2), ['-c']);
        ok(info.exe.includes('python'), info.exe);
        eq(info.cwd, GAME_DIR);
        eq(info.env, {WANTED: 'yes'});
        // Unreadable process: only what /proc lets through.
        eq(process.readProcess(1, new Set(['PATH'])).env, {});
        eq(process.readProcess(999999999, new Set(['PATH'])), {pid: 999999999, argv: [], exe: null, cwd: null, env: {}});
    } finally {
        kill(pid);
    }
});

test('process: mappedProgram finds the .exe a process has mapped', () => {
    const pid = spawnMapper(['python3', '-c', MAPPER, GAME_EXE]);
    try {
        eq(process.mappedProgram(pid, 'S:\\Games\\Some Game.exe'), GAME_EXE);
        eq(process.mappedProgram(pid, 'Other.exe'), null);
        eq(process.mappedProgram(0, 'x.exe'), null);
        eq(process.mappedProgram(pid, null), null);
        eq(process.mappedProgram(1, 'x.exe'), null, 'unreadable maps');
    } finally {
        kill(pid);
    }
});

test('process: mappedProgram ignores paths only another namespace sees', () => {
    if (!GLib.find_program_in_path('bwrap'))
        return;
    const pid = spawnMapper(['bwrap', '--dev-bind', '/', '/', '--tmpfs', '/mnt', '--bind', GAME_DIR, '/mnt/game',
        'python3', '-c', MAPPER, '/mnt/game/Some Game.exe']);
    try {
        eq(process.mappedProgram(pid, 'Some Game.exe'), null);
    } finally {
        kill(pid);
    }
});
