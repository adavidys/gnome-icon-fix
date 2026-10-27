// Icon Fix's messages in the system journal, all prefixed "Icon Fix:":
//
//   journalctl --user -f | grep 'Icon Fix'
//
// Errors and warnings are always written. The details (how each window was
// matched, what the mirrors wrote, how long things took) only with the
// "debug-logging" setting on; they are only built where work happens, not
// on cached paths, so leaving it off costs nothing.

const PREFIX = 'Icon Fix:';

let debugging = false;

export function setDebug(enabled) {
    debugging = !!enabled;
}

export function isDebug() {
    return debugging;
}

export function debug(message) {
    if (debugging)
        console.log(PREFIX, message);
}

export function warn(message) {
    console.warn(PREFIX, message);
}

export function error(message, e = null) {
    console.error(PREFIX, e ? `${message}: ${e}${e.stack ? `\n${e.stack}` : ''}` : message);
}

// Runs fn and logs how long it took; returns fn's result.
export function timed(what, fn) {
    if (!debugging)
        return fn();
    const start = Date.now();
    const result = fn();
    debug(`${what} in ${Date.now() - start} ms`);
    return result;
}
