// Which icon and which name a window Icon Fix handles is shown with, in the
// order the user set (preferences, General): from its .desktop file, from
// its .exe, or GNOME's own (what it would show without Icon Fix).
//
//   desktop: the game's .desktop entry (Icon=, Name=), or, without one,
//            what its launcher knows (Lutris' icon, Heroic's title...)
//   exe:     what the Windows program holds (lib/peicon.js)
//   default: GNOME's own: the launcher's icon and name, or a generic one

export const KINDS = ['desktop', 'exe', 'default'];

// A stored order, repaired: known kinds only, each once, the missing ones
// at the end in their usual place.
export function normalizeOrder(order) {
    const known = (Array.isArray(order) ? order : []).filter((kind, i, all) =>
        KINDS.includes(kind) && all.indexOf(kind) === i);
    return [...known, ...KINDS.filter(kind => !known.includes(kind))];
}

// The first kind in order that has a value (candidates: kind -> value or
// null): {kind, value}. GNOME's own always has one, so it ends the search,
// with a null value: leave it to GNOME.
export function pick(order, candidates) {
    const kinds = normalizeOrder(order);
    const kind = kinds.slice(0, kinds.indexOf('default'))
        .find(k => candidates[k] !== null && candidates[k] !== undefined);
    return kind ? {kind, value: candidates[kind]} : {kind: 'default', value: null};
}
