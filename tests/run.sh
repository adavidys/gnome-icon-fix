#!/bin/sh
# Runs the test suite in a throwaway fake home, with code coverage of src/.
#
#     tests/run.sh [PATTERN]     only the tests whose name matches PATTERN
#
# COVERAGE_LCOV=path also keeps the lcov file.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

python3 -I tests/make-pe.py "$TMP/pe" >/dev/null
sh tests/fixture.sh "$TMP/home" "$TMP/pe" >/dev/null

# Without the JIT: coverage counters stop in functions it compiles.
GJS_DISABLE_JIT=1 HOME="$TMP/home" XDG_DATA_HOME="$TMP/home/.local/share" XDG_CONFIG_HOME="$TMP/home/.config" \
XDG_CACHE_HOME="$TMP/home/.cache" TEST_PE="$TMP/pe" TEST_FILTER="$1" TEST_RESULT="$TMP/result" \
    gjs --coverage-prefix="$ROOT/src" --coverage-output="$TMP/coverage" -m tests/run.js

python3 -I tests/coverage.py "$TMP/coverage/coverage.lcov" "$ROOT/src"
if [ -n "$COVERAGE_LCOV" ]; then cp "$TMP/coverage/coverage.lcov" "$COVERAGE_LCOV"; fi
# The number of failed tests; missing if the run itself broke.
[ "$(cat "$TMP/result" 2>/dev/null)" = 0 ]
