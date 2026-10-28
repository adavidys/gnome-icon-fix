import {eq, test, throws} from './harness.js';
import {parseBinaryVdf, parseVdf, parseYaml} from '../src/lib/formats.js';

test('formats: YAML as Bottles and Lutris write it', () => {
    eq(parseYaml(`# comment
---
Name: Some Bottle
Runner: 'soda'
Quoted: "a\\tb \\"c\\" \\x"
Single: 'it''s'
Empty:
Map: {}
List: []
Wrapped: a long value
  that goes on
next: 1
'quoted key': yes
External_Programs:
  abc:
    name: Game
    path: /x/Game.exe
Items:
- one
-   two
- 'three'
Nested:
  - a
  -
After: z
Indented:
    - x
Map2:
  deep:
    deeper: 1
  back: 2
...
`), {
        Name: 'Some Bottle', Runner: 'soda', Quoted: 'a\tb "c" x', Single: "it's", Empty: null,
        Map: {}, List: [], Wrapped: 'a long value that goes on', next: '1', 'quoted key': 'yes',
        External_Programs: {abc: {name: 'Game', path: '/x/Game.exe'}},
        Items: ['one', 'two', 'three'], Nested: ['a', ''], After: 'z', Indented: ['x'],
        Map2: {deep: {deeper: '1'}, back: '2'},
    });
});

test('formats: YAML oddities are skipped, not fatal', () => {
    // A list item under a map, a key inside a list, text after a quoted value.
    eq(parseYaml('a:\n  b: 1\n  - stray\nlist:\n- x\n  k: v\n"q": "v"\n  more\n'),
        {a: {b: '1'}, list: ['x'], q: 'v'});
    eq(parseYaml(''), {});
    eq(parseYaml('- top level list item\n'), {});
});

test('formats: Valve KeyValues text', () => {
    eq(parseVdf(`"LibraryFolders" // comment
{
    "0" { "Path" "/a\\\\b" "label" "x\\ny\\tz" }
    "1" "/old"
}
}
"stray" `), {libraryfolders: {0: {path: '/a\\b', label: 'x\ny\tz'}, 1: '/old'}, stray: undefined});
    eq(parseVdf('{ "a" "b" }'), {}, 'a map without a key is dropped');
});

test('formats: Valve KeyValues binary', () => {
    const enc = new TextEncoder();
    const bytes = parts => new Uint8Array(parts.flatMap(p => typeof p === 'string' ? [...enc.encode(p), 0] : p));
    const int = n => [...new Uint8Array(new Int32Array([n]).buffer)];
    const float = n => [...new Uint8Array(new Float32Array([n]).buffer)];
    const u64 = n => [...new Uint8Array(new BigUint64Array([n]).buffer)];
    eq(parseBinaryVdf(bytes([
        [0x00], 'Shortcuts',
        [0x00], '0',
        [0x02], 'AppId', int(-2058278936),
        [0x01], 'AppName', 'Game',
        [0x03], 'f', float(1.5),
        [0x07], 'big', u64(5n),
        [0x00], 'tags', [0x08],
        [0x08],
        [0x08],
        [0x08],
    ])), {shortcuts: {0: {appid: -2058278936, appname: 'Game', f: 1.5, big: 5n, tags: {}}}});
    eq(parseBinaryVdf(bytes([[0x01], 'a', 'b'])), {a: 'b'}, 'no closing byte');
    throws(() => parseBinaryVdf(bytes([[0x09], 'x', [1, 2]])), 'unknown type');
    throws(() => parseBinaryVdf(new Uint8Array([0x01, 0x61])), 'truncated');
});
