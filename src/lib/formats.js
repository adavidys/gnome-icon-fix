// Readers for the config formats launchers keep their games in. Each covers
// what those files actually contain, not the whole spec.

// "a: x" — a key and an optional value; the key may be quoted.
const YAML_PAIR = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"#-][^:#]*?|-[^\s:#][^:#]*?):(?:\s+(.*))?$/;

function yamlScalar(str) {
    str = str.trim();
    if (str === '{}')
        return {};
    if (str === '[]')
        return [];
    if (str.length >= 2 && str.startsWith("'") && str.endsWith("'"))
        return str.slice(1, -1).replace(/''/g, "'");
    if (str.length >= 2 && str.startsWith('"') && str.endsWith('"')) {
        return str.slice(1, -1).replace(/\\(.)/g,
            (_m, c) => ({n: '\n', t: '\t', 0: '\0'})[c] ?? c);
    }
    return str;
}

// Block-style YAML as PyYAML writes it (Bottles, Lutris): nested maps,
// lists of scalars (indented or not), quoted and wrapped plain scalars.
// Scalars stay strings.
export function parseYaml(text) {
    const root = {};
    const stack = [{indent: -1, node: root}];
    // A "key:" whose value (a map or a list) starts on the next lines.
    let pending = null;
    // The last plain scalar, which PyYAML wraps onto more indented lines.
    let scalar = null;

    for (const raw of text.split('\n')) {
        const content = raw.trim();
        if (!content || content.startsWith('#') || content === '---' || content === '...')
            continue;
        const indent = raw.search(/\S/);
        const item = content === '-' || content.startsWith('- ');
        const pair = item ? null : content.match(YAML_PAIR);

        if (!item && !pair) {
            if (scalar && indent > scalar.indent)
                scalar.node[scalar.key] += ` ${content}`;
            continue;
        }
        scalar = null;

        if (pending) {
            if (indent > pending.indent || (item && indent === pending.indent)) {
                const node = item ? [] : {};
                pending.node[pending.key] = node;
                stack.push({indent, node});
            }
            pending = null;
        }

        // Leave the maps and lists this line is no longer part of. A list
        // and its parent's keys can share an indent ("key:\n- a\nnext: b").
        while (stack.length > 1) {
            const top = stack[stack.length - 1];
            if (indent < top.indent || (indent === top.indent && Array.isArray(top.node) !== item))
                stack.pop();
            else
                break;
        }
        const {node} = stack[stack.length - 1];

        if (item) {
            if (Array.isArray(node))
                node.push(yamlScalar(content.slice(1)));
            continue;
        }
        if (Array.isArray(node))
            continue;

        const key = yamlScalar(pair[1]);
        if (pair[2] === undefined) {
            node[key] = null;
            pending = {node, key, indent};
        } else {
            node[key] = yamlScalar(pair[2]);
            if (!/^['"{[]/.test(pair[2]))
                scalar = {node, key, indent};
        }
    }
    return root;
}

// Valve's KeyValues text format (libraryfolders.vdf, appmanifest_*.acf).
// Keys are lowercased: Steam isn't consistent about their case.
export function parseVdf(text) {
    const root = {};
    const stack = [root];
    let key = null;
    for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*/g)) {
        if (m[2] === '{') {
            const node = {};
            if (key !== null)
                stack[stack.length - 1][key] = node;
            stack.push(node);
            key = null;
        } else if (m[2] === '}') {
            if (stack.length > 1)
                stack.pop();
            key = null;
        } else if (m[1] !== undefined) {
            const str = m[1].replace(/\\(.)/g, (_m, c) => ({n: '\n', t: '\t'})[c] ?? c);
            if (key === null) {
                key = str.toLowerCase();
            } else {
                stack[stack.length - 1][key] = str;
                key = null;
            }
        }
    }
    return root;
}

// Valve's binary KeyValues (shortcuts.vdf, Steam's non-Steam games):
// typed fields, maps closed by 0x08. Keys are lowercased like parseVdf().
export function parseBinaryVdf(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    let pos = 0;
    const cstring = () => {
        const end = bytes.indexOf(0, pos);
        if (end < 0)
            throw new Error('truncated string');
        const str = decoder.decode(bytes.subarray(pos, end));
        pos = end + 1;
        return str;
    };
    const map = () => {
        const node = {};
        while (pos < bytes.length) {
            const type = bytes[pos++];
            if (type === 0x08)
                return node;
            const key = cstring().toLowerCase();
            switch (type) {
            case 0x00:
                node[key] = map();
                break;
            case 0x01:
                node[key] = cstring();
                break;
            case 0x02:
                node[key] = view.getInt32(pos, true);
                pos += 4;
                break;
            case 0x03:
                node[key] = view.getFloat32(pos, true);
                pos += 4;
                break;
            case 0x07:
                node[key] = view.getBigUint64(pos, true);
                pos += 8;
                break;
            default:
                throw new Error(`unknown field type ${type}`);
            }
        }
        return node;
    };
    return map();
}
