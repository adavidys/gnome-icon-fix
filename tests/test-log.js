import {eq, test} from './harness.js';
import * as log from '../src/lib/log.js';

test('log: debug only when enabled, timed returns the result', () => {
    log.setDebug(false);
    eq(log.isDebug(), false);
    log.debug('not shown');
    eq(log.timed('quiet', () => 1), 1);
    log.setDebug(1);
    eq(log.isDebug(), true);
    log.debug('shown');
    eq(log.timed('loud', () => 2), 2);
    log.setDebug(false);
    log.warn('a warning');
    log.error('an error');
    log.error('with exception', new Error('boom'));
    const noStack = new Error('no stack');
    noStack.stack = '';
    log.error('without stack', noStack);
});
