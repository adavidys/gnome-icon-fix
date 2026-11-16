import {eq, test} from './harness.js';
import {KINDS, cleanTitle, normalizeOrder, pick, shownTitle} from '../src/lib/look.js';

test('look: orders as stored, repaired', () => {
    eq(normalizeOrder(KINDS), ['desktop', 'exe', 'default']);
    eq(normalizeOrder(['exe', 'default', 'desktop']), ['exe', 'default', 'desktop']);
    eq(normalizeOrder(['exe']), ['exe', 'desktop', 'default'], 'missing ones appended');
    eq(normalizeOrder(['exe', 'nope', 'exe']), ['exe', 'desktop', 'default'], 'unknown and repeated ones dropped');
    eq(normalizeOrder(null), KINDS);
});

test('look: the first kind that has something', () => {
    const both = {desktop: 'd', exe: 'e'};
    eq(pick(KINDS, both), {kind: 'desktop', value: 'd'});
    eq(pick(['exe', 'desktop', 'default'], both), {kind: 'exe', value: 'e'});
    eq(pick(KINDS, {desktop: null, exe: 'e'}), {kind: 'exe', value: 'e'}, 'nothing from .desktop');
    eq(pick(KINDS, {}), {kind: 'default', value: null}, 'nothing at all: GNOME\'s');
    eq(pick(['default', 'desktop', 'exe'], both), {kind: 'default', value: null}, 'GNOME\'s first');
    eq(pick(['desktop', 'default', 'exe'], {exe: 'e'}), {kind: 'default', value: null}, 'nothing after GNOME\'s is used');
});

test('look: window titles that agree with the dock', () => {
    eq(cleanTitle('​TH​﻿﻿​​​E F​​IN​﻿A​​L﻿S'), 'THE FINALS');
    eq(cleanTitle('  a \n b  '), 'a b');
    eq(cleanTitle(null), '');
    eq(shownTitle('osu!', 'osu!lazer'), 'osu!lazer', 'says nothing more than the name');
    eq(shownTitle('​THE FIN﻿ALS', 'THE FINALS'), 'THE FINALS');
    eq(shownTitle('', 'Game'), 'Game', 'no title');
    eq(shownTitle('!!!', 'Game'), 'Game', 'no letters');
    eq(shownTitle('Save 3 - Hollow​ Knight', 'Hollow Knight'), 'Save 3 - Hollow Knight', 'more than the name: kept, cleaned');
    eq(shownTitle('report.odt', null), 'report.odt');
});
