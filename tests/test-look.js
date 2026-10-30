import {eq, test} from './harness.js';
import {KINDS, normalizeOrder, pick} from '../src/lib/look.js';

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
