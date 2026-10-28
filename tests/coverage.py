#!/usr/bin/env python3
"""Summarizes gjs's lcov output per source file: lines and branches
covered, and which lines (or branches) no test reached.

    coverage.py COVERAGE.lcov SRC_DIR
"""

import os
import sys

# The modules that run in plain gjs, and so must be fully covered here. The
# others need GNOME Shell and are tested there.
TESTED_HERE = ['lib', 'sources', 'mirror']


def parse(path):
    files = {}
    current = None
    for line in open(path):
        line = line.strip()
        if line.startswith('SF:'):
            current = files.setdefault(line[3:], {'lines': {}, 'branches': {}})
        elif line.startswith('DA:') and current is not None:
            number, hits = line[3:].split(',')[:2]
            current['lines'][int(number)] = current['lines'].get(int(number), 0) + int(hits)
        elif line.startswith('BRDA:') and current is not None:
            number, block, branch, taken = line[5:].split(',')
            key = (int(number), block, branch)
            current['branches'][key] = current['branches'].get(key, 0) + (0 if taken == '-' else int(taken))
    return files


def ranges(numbers):
    out = []
    for n in sorted(numbers):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return ', '.join(str(a) if a == b else f'{a}-{b}' for a, b in out)


def main(lcov, src):
    files = parse(lcov)
    # gjs writes SF: paths under its output folder; match them by their
    # path relative to src/.
    by_rel = {}
    for path, data in files.items():
        for marker in TESTED_HERE + ['']:
            idx = path.find(f'/{marker}/') if marker else -1
            if idx >= 0:
                by_rel[path[idx + 1:]] = data
                break
        else:
            by_rel[os.path.basename(path)] = data
    expected = sorted(os.path.join(d, f) for d in TESTED_HERE
                      for f in os.listdir(os.path.join(src, d)) if f.endswith('.js'))
    total_l = total_lh = total_b = total_bh = 0
    gaps = []
    print(f'{"file":32} {"lines":>12} {"branches":>12}')
    for rel in expected:
        data = by_rel.get(rel)
        if not data:
            print(f'{rel:32} {"not loaded":>12}')
            gaps.append(f'{rel}: never loaded')
            continue
        lines = data['lines']
        branches = data['branches']
        lh = sum(1 for h in lines.values() if h)
        bh = sum(1 for h in branches.values() if h)
        total_l += len(lines)
        total_lh += lh
        total_b += len(branches)
        total_bh += bh
        pct = lambda a, b: f'{a}/{b}' + (f' {100 * a // b}%' if b else '')
        print(f'{rel:32} {pct(lh, len(lines)):>12} {pct(bh, len(branches)):>12}')
        missed_lines = [n for n, h in lines.items() if not h]
        missed_branches = sorted({n for (n, _b, _r), h in branches.items() if not h} - set(missed_lines))
        if missed_lines:
            gaps.append(f'{rel}: lines {ranges(missed_lines)}')
        if missed_branches:
            gaps.append(f'{rel}: branches on lines {ranges(missed_branches)}')
    print(f'{"total":32} {f"{total_lh}/{total_l}":>12} {f"{total_bh}/{total_b}":>12}')
    if gaps:
        print('\nnot covered:')
        for gap in gaps:
            print(f'  {gap}')


if __name__ == '__main__':
    main(*sys.argv[1:])
