import {eq, test} from './harness.js';
import {KINDS, cleanTitle, normalizeOrder, pick, shownTitle, titleName} from '../src/lib/look.js';

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
    eq(cleanTitle('\u200BTH\u200B\uFEFF\uFEFF\u200B\u200B\u200BE F\u200B\u200BIN\u200B\uFEFFA\u200B\u200BL\uFEFFS'), 'THE FINALS');
    eq(cleanTitle('  a \n b  '), 'a b');
    eq(cleanTitle(null), '');
    eq(shownTitle('osu!', 'osu!lazer'), 'osu!lazer');
    eq(shownTitle("Baldur's Gate 3 (1920x1080) - (Vulkan) - (6 + 6 WT)", "Baldur's Gate 3"), "Baldur's Gate 3", 'always the app\'s name');
    eq(shownTitle('\u200BTHE FIN\uFEFFALS', null), 'THE FINALS', 'no name: the title, cleaned');
    eq(titleName('Одни  из нас™: Часть I', 'The Last of Us™ Part I'), 'Одни из нас™: Часть I', 'another name: the title');
    eq(titleName('The Last of Us™ Part I', 'The Last of Us Part I'), null, 'the name');
    eq(titleName('osu!', 'osu!lazer'), null, 'a part of the name');
    eq(titleName("Baldur's Gate 3 (1920x1080) - (Vulkan) - (6 + 6 WT)", "Baldur's Gate 3"), null, 'the name and more');
    eq(titleName('FPS: 60 | THE FINALS', 'THE FINALS'), null, 'the name after more');
    eq(titleName('\u200B ', 'Game'), null, 'nothing to read');
    eq(titleName('Something', null), null, 'no name');
});
