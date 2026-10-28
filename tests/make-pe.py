#!/usr/bin/env python3
"""Writes small synthetic Windows programs (.exe) for the tests of
lib/peicon.js: each has a resource section with exactly the icons and
version strings a test needs, including broken and hostile ones.

    make-pe.py OUT_DIR
"""

import os
import struct
import sys
import zlib

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16


def png(width, height, rgba=(200, 30, 60, 255)):
    """A solid PNG, written by hand (no imaging library needed)."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\0' + bytes(rgba) * width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def dib(size, bpp, alpha=True, colors=0, header_size=None):
    """A BMP icon image (DIB): header, palette, bottom-up pixels, AND mask.
    The left half is red, the right half blue; with no alpha, the mask makes
    the top row transparent. header_size: (width, height) to claim instead."""
    width, height = header_size or (size, size)
    header = struct.pack('<IiiHHIIiiII', 40, width, height * 2, 1, bpp, 0, 0, 0, 0, colors, 0)
    palette = b''
    if bpp <= 8:
        count = colors or (1 << bpp)
        palette = b''.join(struct.pack('<BBBB', *((255, 0, 0, 0) if i % 2 else (0, 0, 255, 0))) for i in range(count))
    stride = (size * bpp + 31) // 32 * 4
    rows = []
    for y in range(size):
        bits = []
        row = bytearray(stride)
        for x in range(size):
            red = x < size // 2
            if bpp == 32:
                row[x * 4:x * 4 + 4] = bytes((0, 0, 255, 255 if alpha else 0) if red else (255, 0, 0, 255 if alpha else 0))
            elif bpp == 24:
                row[x * 3:x * 3 + 3] = bytes((0, 0, 255) if red else (255, 0, 0))
            elif bpp == 16:
                pass  # a depth peicon.js doesn't decode: left black
            else:
                index = 0 if red else 1
                bit = x * bpp
                row[bit // 8] |= index << (8 - bpp - bit % 8)
        rows.append(bytes(row))
    mask_stride = (size + 31) // 32 * 4
    mask = b''
    for y in range(size):
        line = bytearray(mask_stride)
        if y == size - 1:  # bottom-up: the last row stored is the top one
            for x in range(size):
                line[x // 8] |= 0x80 >> (x % 8)
        mask += bytes(line)
    return header + palette + b''.join(rows) + mask


def group(entries):
    """GRPICONDIR: [(size, bpp, icon id)]."""
    out = struct.pack('<HHH', 0, 1, len(entries))
    for size, bpp, icon_id in entries:
        out += struct.pack('<BBBBHHIH', size % 256, size % 256, 0, 0, 1, bpp, 0, icon_id)
    return out


def version(strings):
    """Enough of a VS_VERSIONINFO for the String blocks to be found."""
    out = struct.pack('<HHH', 0, 0, 0) + 'VS_VERSION_INFO\0'.encode('utf-16le')
    out += b'\0' * (-len(out) % 4)
    for key, value in strings.items():
        k = (key + '\0').encode('utf-16le')
        v = (value + '\0').encode('utf-16le')
        block = struct.pack('<HHH', 0, len(value) + 1, 1) + k
        block += b'\0' * (-len(block) % 4) + v
        block += b'\0' * (-len(block) % 4)
        out += block
    return out


def resource_section(resources, rva, cycle=False, named=False, huge=False, bad_offset=0, many=False):
    """resources: {type: [(id, data)]} -> bytes of a .rsrc section at rva.
    cycle: the first type's name directory points back at itself.
    named: add an entry with a name instead of an id.
    huge: every data entry claims 2 GiB.
    bad_offset: data entries point that far past (or before) their data.
    many: the root directory claims 5000 entries."""
    types = sorted(resources)
    dirs = bytearray()
    data_entries = []
    blobs = bytearray()

    def directory(entries):
        # entries: [(name_or_id, target)]; returns offset
        offset = len(dirs)
        n_named = sum(1 for e in entries if isinstance(e[0], str))
        dirs.extend(struct.pack('<IIHHHH', 0, 0, 0, 0, n_named, len(entries) - n_named))
        for name, target in entries:
            dirs.extend(struct.pack('<II', 0x80000000 if isinstance(name, str) else name, target))
        return offset

    # Lay out: root, then type dirs, then name dirs, then language dirs.
    root_size = 16 + 8 * len(types)
    plan = []
    cursor = root_size
    for t in types:
        items = resources[t]
        type_dir = cursor
        cursor += 16 + 8 * (len(items) + (1 if named and t == types[0] else 0))
        plan.append((t, type_dir, items))
    lang_dirs = {}
    for t, _, items in plan:
        for item_id, _ in items:
            lang_dirs[(t, item_id)] = cursor
            cursor += 16 + 8
    data_start = cursor
    entry_offset = {}
    for t, _, items in plan:
        for item_id, _ in items:
            entry_offset[(t, item_id)] = data_start + 16 * len(entry_offset)
    blob_start = data_start + 16 * len(entry_offset)

    directory([(t, 0x80000000 | type_dir) for t, type_dir, _ in plan])
    for index, (t, type_dir, items) in enumerate(plan):
        entries = [(item_id, 0x80000000 | (type_dir if cycle and index == 0 else lang_dirs[(t, item_id)]))
                   for item_id, _ in items]
        if named and index == 0:
            entries = [('name', 0x80000000 | lang_dirs[(t, items[0][0])])] + entries
        directory(entries)
    for t, _, items in plan:
        for item_id, _ in items:
            directory([(1033, entry_offset[(t, item_id)])])
    for t, _, items in plan:
        for item_id, data in items:
            data_entries.append((rva + blob_start + len(blobs) + bad_offset,
                                 0x7fffffff if huge else len(data)))
            blobs.extend(data)
            blobs.extend(b'\0' * (-len(blobs) % 4))
    for data_rva, size in data_entries:
        dirs.extend(struct.pack('<IIII', data_rva, size, 0, 0))
    assert len(dirs) == blob_start, (len(dirs), blob_start)
    if many:
        struct.pack_into('<HH', dirs, 12, 0, 5000)
    return bytes(dirs + blobs)


def pe(resources, pe32=False, cycle=False, named=False, huge=False, no_rsrc=False, rva_outside=False,
       rva_below=False, bad_offset=0, many=False):
    rva = 0x1000
    section = resource_section(resources, rva, cycle, named, huge, bad_offset, many) if resources else b''
    raw = 0x200
    opt_size = 224 if pe32 else 240
    dirs_at = 96 if pe32 else 112
    out = bytearray(raw + len(section) + (-len(section) % 0x200))
    out[0:2] = b'MZ'
    struct.pack_into('<I', out, 0x3c, 0x40)
    out[0x40:0x44] = b'PE\0\0'
    struct.pack_into('<HHIIIHH', out, 0x44, 0x14c if pe32 else 0x8664, 1, 0, 0, 0, opt_size, 0x22)
    opt = 0x58
    struct.pack_into('<H', out, opt, 0x10b if pe32 else 0x20b)
    dir_rva = 0 if no_rsrc else 0x9000 if rva_outside else 0x800 if rva_below else rva
    struct.pack_into('<II', out, opt + dirs_at + 2 * 8, dir_rva, len(section))
    sec = opt + opt_size
    out[sec:sec + 8] = b'.rsrc\0\0\0'
    struct.pack_into('<IIII', out, sec + 8, len(section), rva, len(section), raw)
    out[raw:raw + len(section)] = section
    return bytes(out)


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    big = png(256, 256)
    files = {
        # Largest icon is a PNG; also name from ProductName.
        'png.exe': pe({RT_GROUP_ICON: [(1, group([(32, 32, 2), (256, 32, 1)]))],
                       RT_ICON: [(1, big), (2, dib(32, 32))],
                       RT_VERSION: [(1, version({'CompanyName': 'Test', 'ProductName': 'Png Game'}))]}),
        # Only FileDescription; 32-bit PE.
        'pe32.exe': pe({RT_GROUP_ICON: [(1, group([(48, 32, 1)]))], RT_ICON: [(1, dib(48, 32))],
                        RT_VERSION: [(1, version({'FileDescription': 'Thirty Two'}))]}, pe32=True),
        # Each BMP depth on its own.
        **{f'bmp{bpp}.exe': pe({RT_GROUP_ICON: [(1, group([(16, bpp, 1)]))], RT_ICON: [(1, dib(16, bpp))]})
           for bpp in (24, 8, 4, 1)},
        'bmp32-noalpha.exe': pe({RT_GROUP_ICON: [(1, group([(16, 32, 1)]))], RT_ICON: [(1, dib(16, 32, alpha=False))]}),
        'bmp8-colors.exe': pe({RT_GROUP_ICON: [(1, group([(16, 8, 1)]))], RT_ICON: [(1, dib(16, 8, colors=2))]}),
        # Unusable images first, then a good one: the good one is used.
        'fallback.exe': pe({RT_GROUP_ICON: [(1, group([(256, 32, 9), (128, 16, 1), (32, 32, 2)]))],
                            RT_ICON: [(1, dib(16, 16)), (2, dib(32, 32))]}),
        # No usable image at all, but a version name.
        'noimage.exe': pe({RT_GROUP_ICON: [(1, group([(32, 16, 1)]))], RT_ICON: [(1, dib(32, 16))],
                           RT_VERSION: [(1, version({'ProductName': 'Name Only'}))]}),
        # A tiny PNG claiming to be huge, and a BMP too large to decode.
        'bigpng.exe': pe({RT_GROUP_ICON: [(1, group([(0, 32, 1)]))], RT_ICON: [(1, png(2048, 1))]}),
        'bigbmp.exe': pe({RT_GROUP_ICON: [(1, group([(0, 32, 1)]))], RT_ICON: [(1, dib(1100, 1))]}),
        # Version strings only / empty values.
        'versiononly.exe': pe({RT_VERSION: [(1, version({'ProductName': ' ', 'FileDescription': 'Described'}))]}),
        'novalue.exe': pe({RT_VERSION: [(1, version({'ProductName': ''}))]}),
        # Hostile tables.
        'cycle.exe': pe({RT_GROUP_ICON: [(1, group([(32, 32, 1)]))], RT_ICON: [(1, dib(32, 32))]}, cycle=True),
        'huge.exe': pe({RT_GROUP_ICON: [(1, group([(32, 32, 1)]))], RT_ICON: [(1, dib(32, 32))],
                        RT_VERSION: [(1, version({'ProductName': 'Huge'}))]}, huge=True),
        'named.exe': pe({RT_GROUP_ICON: [(1, group([(32, 32, 1)]))], RT_ICON: [(1, dib(32, 32))]}, named=True),
        # Not a usable program.
        'norsrc.exe': pe({RT_ICON: [(1, b'x')]}, no_rsrc=True),
        'outside.exe': pe({RT_ICON: [(1, b'x')]}, rva_outside=True),
        'empty-rsrc.exe': pe({RT_ICON: [(1, b'x')]}),
        # Images that can't be decoded, and a tie on size decided by depth.
        'oddbmps.exe': pe({RT_GROUP_ICON: [(1, group([(32, 32, 1), (32, 32, 2), (32, 32, 3), (32, 32, 4)]))],
                           RT_ICON: [(1, dib(4, 32, header_size=(4, 1100))), (2, dib(4, 32, header_size=(4, -4))),
                                     (3, dib(4, 32, header_size=(0, 4))), (4, b'\x89PNG\r\n\x1a\nnot really')]}),
        'tie.exe': pe({RT_GROUP_ICON: [(1, group([(16, 24, 1), (16, 32, 2)]))],
                       RT_ICON: [(1, dib(16, 24)), (2, dib(16, 32))]}),
        'emptytype.exe': pe({RT_GROUP_ICON: [], RT_ICON: [(1, dib(16, 32))]}),
        'outrange.exe': pe({RT_GROUP_ICON: [(1, group([(16, 32, 1)]))], RT_ICON: [(1, dib(16, 32))]}, bad_offset=1 << 20),
        'before.exe': pe({RT_GROUP_ICON: [(1, group([(16, 32, 1)]))], RT_ICON: [(1, dib(16, 32))]}, bad_offset=-0x900),
        'many.exe': pe({RT_ICON: [(1, dib(16, 32))]}, many=True),
        'below.exe': pe({RT_ICON: [(1, b'x')]}, rva_below=True),
        'notpe.exe': b'MZ' + b'\0' * 0x3a + struct.pack('<I', 0x40) + b'XX\0\0' + b'\0' * 64,
        'notmz.exe': b'hello, not a program' + b'\0' * 80,
        'truncated.exe': b'MZ' + b'\0' * 10,
    }
    for name, data in files.items():
        with open(os.path.join(out_dir, name), 'wb') as f:
            f.write(data)
    # An oddly-typed optional header.
    odd = bytearray(files['png.exe'])
    struct.pack_into('<H', odd, 0x58, 0x107)
    with open(os.path.join(out_dir, 'oddmagic.exe'), 'wb') as f:
        f.write(odd)
    print(len(files) + 1, 'programs in', out_dir)


if __name__ == '__main__':
    main(sys.argv[1])
