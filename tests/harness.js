// A minimal test runner for plain gjs: test(), assertions, run().

import GLib from 'gi://GLib';

const tests = [];
let only = null;

export function test(name, fn) {
    tests.push({name, fn});
}

const show = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? `${v}n` : v);

export function eq(actual, expected, message = '') {
    const a = show(actual);
    const e = show(expected);
    if (a !== e)
        throw new Error(`${message}\n    expected ${e}\n    actual   ${a}`);
}

export function ok(value, message = 'expected a true value') {
    if (!value)
        throw new Error(`${message} (got ${show(value)})`);
}

export function throws(fn, message = 'expected an exception') {
    try {
        fn();
    } catch {
        return;
    }
    throw new Error(message);
}

// The fake home the tests run in (tests/fixture.sh) and its paths.
export const HOME = GLib.get_home_dir();
export const GAME_DIR = `${HOME}/Games/Some Game`;
export const GAME_EXE = `${GAME_DIR}/Some Game.exe`;
export const PE = GLib.getenv('TEST_PE');

// Paths in results, shortened for comparison.
export function short(value) {
    return typeof value === 'string'
        ? value.replace(HOME, '~').replace(/\/[0-9a-f]{40}\.png$/, '/<sha1>.png')
        : value;
}

export function filter(pattern) {
    only = pattern ? new RegExp(pattern) : null;
}

export async function run() {
    let failed = 0;
    let ran = 0;
    for (const {name, fn} of tests) {
        if (only && !only.test(name))
            continue;
        ran++;
        try {
            await fn();
        } catch (e) {
            failed++;
            print(`FAIL ${name}: ${e.message}`);
            print(`  ${(e.stack ?? '').split('\n').slice(0, 3).join('\n  ')}`);
        }
    }
    print(`${ran - failed}/${ran} tests passed`);
    return failed;
}
