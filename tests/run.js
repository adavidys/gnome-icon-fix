// Runs every test module (see tests/run.sh for the environment).

import GLib from 'gi://GLib';

import {filter, run} from './harness.js';

import './test-util.js';
import './test-formats.js';
import './test-process.js';
import './test-peicon.js';
import './test-lnk.js';
import './test-look.js';
import './test-log.js';
import './test-appindex.js';
import './test-sources.js';
import './test-matcher.js';
import './test-mirrors.js';

filter(GLib.getenv('TEST_FILTER'));
const failed = await run();
// gjs only writes the coverage when the script ends normally, so the result
// goes through a file (see run.sh).
GLib.file_set_contents(GLib.getenv('TEST_RESULT'), String(failed));
