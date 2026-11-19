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

// Characters that draw nothing: zero-width spaces and joiners, word
// joiners, byte order marks, soft hyphens, bidi controls. Games put them in
// their window titles (THE FINALS: "​TH​﻿﻿E F​IN…") so tools can't read them.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

// A window title as it reads: without invisible characters, its spaces
// collapsed.
export function cleanTitle(title) {
    return (title ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

// Letters and digits only, lowercased: "The Last of Us™ Part I" ->
// "thelastofuspart1".
function letters(str) {
    return (str ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// The name a game gives its own window when that is another name for it
// than name: a translation it switches to once it has read its language
// ("The Last of Us™ Part I", a few seconds later "Одни из нас™: Часть I").
// null when the title is the name, a part of it ("osu!" for osu!lazer) or
// holds it among other things (a resolution, a renderer, an FPS counter:
// "Baldur's Gate 3 (1920x1080) - (Vulkan)"), and without a name.
export function titleName(title, name) {
    const clean = cleanTitle(title);
    const own = letters(clean);
    const known = letters(name);
    return own && known && !known.includes(own) && !own.includes(known) ? clean : null;
}

// What a window Icon Fix placed is called in the window switcher, the
// overview and window lists: its app's name, as the dock has it, so every
// one of them agrees (a game's own title is "osu!" for osu!lazer, "Baldur's
// Gate 3 (1920x1080) - (Vulkan)", or full of hidden characters). Without a
// name, the title cleaned.
export function shownTitle(title, name) {
    return name || cleanTitle(title);
}
