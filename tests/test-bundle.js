import GLib from 'gi://GLib';

import {HOME, eq, ok, short, test} from './harness.js';
import {
    appDirOf, appImageServing, bundleIcon, bundleOf, forgetBundles, keepIcon, mountSource, parseEntry, snapDirOf,
} from '../src/lib/bundle.js';

const MOUNT = `${HOME}/tmp/.mount_Foo AbC`;
const PROC = `${HOME}/proc`;
const proc = (exe, env = {}, pid = 100, argv = []) => ({pid, argv, exe, cwd: '/', env});

test('bundle: AppDir and Snap roots', () => {
    eq(appDirOf(`${MOUNT}/foo`), MOUNT);
    eq(appDirOf(`${MOUNT}/usr/lib/libx.so`), MOUNT, 'from deeper down');
    eq(appDirOf(`${HOME}/tmp/.mount_Bare/AppRun`), `${HOME}/tmp/.mount_Bare`, 'a .DirIcon is enough');
    eq(appDirOf(`${HOME}/tmp/not-appdir/bin/x`), null, 'AppRun alone isn\'t');
    eq(appDirOf('/usr/bin/true'), null);
    eq(appDirOf('relative/x'), null);
    eq(snapDirOf('/snap/spotify/85/usr/bin/spotify'), '/snap/spotify/85');
    eq(snapDirOf('/snap/bin/spotify'), null, 'a launcher, not inside a snap');
    eq(snapDirOf('/usr/bin/x'), null);
    eq(snapDirOf(null), null);
});

test('bundle: entries', () => {
    const entry = parseEntry(`${MOUNT}/foo.desktop`);
    eq(entry, {id: 'foo.desktop', name: 'Foo App', icon: 'foo-icon', wmClass: 'FooClass', exec: 'AppRun %U'});
    eq(parseEntry(`${HOME}/tmp/.mount_NoIcon/link.desktop`), null, 'not an application');
    eq(parseEntry(`${HOME}/tmp/.mount_NoIcon/broken.desktop`), null);
    eq(parseEntry(`${HOME}/nope.desktop`), null);
    eq(parseEntry(`${HOME}/tmp/.mount_NoIcon/noicon.desktop`).wmClass, null, 'empty keys');
    eq(parseEntry(`${HOME}/tmp/.mount_Foo AbC/a-helper.desktop`).exec, null, 'missing keys');
});

test('bundle: mount sources and the runtime serving them', () => {
    const info = GLib.file_get_contents(`${PROC}/100/mountinfo`)[1];
    eq(mountSource(new TextDecoder().decode(info), MOUNT), 'Foo-1.0.AppImage', 'escaped mount point');
    eq(mountSource('garbage\n1 2 3\n', MOUNT), null);
    eq(mountSource('1 2 3 4 /m ro - fuse\n', '/m'), null, 'no source');
    eq(short(appImageServing(100, MOUNT, PROC)), '~/Applications/Foo-1.0.AppImage', 'the nearest one');
    eq(appImageServing(99, `${HOME}/tmp/.mount_Bare`, PROC), null, 'not an AppImage mount');
    eq(appImageServing(100, '/elsewhere', PROC), null, 'not mounted there');
    eq(appImageServing(5, MOUNT, PROC), null, 'no mountinfo');
    eq(appImageServing(100, MOUNT, `${HOME}/nope`), null);
    eq(appImageServing(98, MOUNT, PROC), null, 'its runtime isn\'t running');
});

test('bundle: icons inside a bundle, kept outside it', () => {
    const layout = {shares: [`${MOUNT}/usr/share`], dirs: [MOUNT]};
    eq(short(bundleIcon(MOUNT, 'foo-icon', layout)), '~/tmp/.mount_Foo AbC/usr/share/icons/hicolor/64x64/apps/foo-icon.png');
    eq(short(bundleIcon(MOUNT, 'AppRun', {dirs: [MOUNT]})), '~/tmp/.mount_Foo AbC/.DirIcon', 'not an icon file: .DirIcon');
    eq(short(bundleIcon(MOUNT, '${SNAP}/.DirIcon')), '~/tmp/.mount_Foo AbC/.DirIcon', 'a path in the bundle');
    eq(short(bundleIcon(MOUNT, '$SNAP/foo')), '~/tmp/.mount_Foo AbC/foo');
    eq(bundleIcon(MOUNT, '/etc/passwd'), null, 'outside the bundle');
    eq(bundleIcon(MOUNT, '${SNAP}/gone.png'), null);
    eq(bundleIcon(`${HOME}/tmp/.mount_NoIcon`, 'missing', layout), null);
    eq(bundleIcon(MOUNT, 'icons/x.png'), null, 'a relative path');
    eq(short(bundleIcon(MOUNT, 'helper', {shares: [`${MOUNT}/nope`], dirs: [`${MOUNT}/sub`, MOUNT]})),
        '~/tmp/.mount_Foo AbC/helper.png', 'next to the entry');
    eq(short(bundleIcon(MOUNT, null)), '~/tmp/.mount_Foo AbC/.DirIcon');
    const kept = keepIcon(`${MOUNT}/.DirIcon`);
    ok(/\/\.cache\/icon-fix\/bundle-icons\/[0-9a-f]{40}\.png$/.test(kept), kept);
    eq(keepIcon(`${MOUNT}/.DirIcon`), kept, 'once');
    ok(keepIcon(`${HOME}/tmp/.mount_Bare/.DirIcon`).endsWith('.svg'), 'an SVG stays one');
    eq(keepIcon(`${HOME}/nope.png`), null);
    // A cache it can't write to.
    const dir = `${HOME}/.cache/icon-fix/bundle-icons`;
    GLib.rename(dir, `${dir}.away`);
    GLib.file_set_contents(dir, 'in the way');
    try {
        eq(keepIcon(`${MOUNT}/helper.png`), null);
    } finally {
        GLib.unlink(dir);
        GLib.rename(`${dir}.away`, dir);
    }
});

test('bundle: what a process runs from', () => {
    forgetBundles();
    const foo = bundleOf(proc(`${MOUNT}/foo`, {}, 100), PROC);
    eq(foo.kind, 'appimage');
    eq(foo.root, MOUNT);
    eq(short(foo.file), '~/Applications/Foo-1.0.AppImage', 'from the runtime, the environment being empty');
    eq(foo.entry.name, 'Foo App', 'the entry named like the program');
    ok(foo.icon.includes('/bundle-icons/'));
    eq(bundleOf(proc(`${MOUNT}/foo`, {}, 7)), foo, 'read once per mount');
    forgetBundles();
    eq(bundleOf(proc('/x', {APPDIR: MOUNT, APPIMAGE: `${HOME}/elsewhere/Foo-1.0.AppImage`}, 7)).file,
        `${HOME}/elsewhere/Foo-1.0.AppImage`, 'by APPDIR and APPIMAGE when they are there');
    forgetBundles();
    eq(bundleOf(proc(null, {}, 7, [`${HOME}/tmp/.mount_Bare/AppRun`])).entry, null, 'by argv; no entry');
    eq(bundleOf(proc('/x', {APPDIR: '/nope'})), null);
    eq(bundleOf(proc('/usr/bin/true')), null);
    const noIcon = bundleOf(proc(`${HOME}/tmp/.mount_NoIcon/opt/x`));
    eq([noIcon.entry.name, noIcon.icon], ['No Icon', null]);
    const snap = bundleOf(proc('/snap/spotify/85/usr/bin/spotify'));
    eq([snap.kind, snap.root, snap.file, snap.entry], ['snap', '/snap/spotify/85', null, null]);
    for (let i = 0; i < 70; i++)
        bundleOf(proc(`/snap/s${i}/1/x`));
    ok(bundleOf(proc('/snap/s69/1/x')), 'old ones are dropped, not the newest');
});
