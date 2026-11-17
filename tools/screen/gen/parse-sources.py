# Extract cairo's authoritative source lists from src/Makefile.sources
# without running configure or make.
#
# Usage: python parse-sources.py <path-to-cairo/src> <out-dir>

import io, re, os, sys

BACKSLASH = chr(92)

src_dir = sys.argv[1]
out_dir = sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

path = os.path.join(src_dir, 'Makefile.sources')
lines = io.open(path, encoding='utf-8', errors='replace').read().splitlines()

defs = {}
i = 0
while i < len(lines):
    ln = lines[i].rstrip()
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*([+]?=)\s*(.*)$', ln)
    if not m:
        i += 1
        continue
    name, op, rest = m.group(1), m.group(2), m.group(3)
    parts = []
    while True:
        cont = rest.endswith(BACKSLASH)
        parts.append(rest[:-1] if cont else rest)
        if not cont:
            break
        i += 1
        if i >= len(lines):
            break
        rest = lines[i].rstrip()
    blob = ' '.join(parts)
    files = [t for t in blob.split() if t.endswith('.c')]
    refs = re.findall(r'[$][(]([A-Za-z_][A-Za-z0-9_]*)[)]', blob)
    d = defs.setdefault(name, {'files': [], 'refs': []})
    if op == '=':
        d['files'], d['refs'] = files, refs
    else:
        d['files'] += files
        d['refs'] += refs
    i += 1


def expand(n, seen=None):
    seen = seen if seen is not None else set()
    if n in seen or n not in defs:
        return []
    seen.add(n)
    out = list(defs[n]['files'])
    for r in defs[n]['refs']:
        out += expand(r, seen)
    return out


groups = ['cairo_sources', 'cairo_ft_sources', 'cairo_png_sources']
total = []
for g in groups:
    f = expand(g)
    total += f
    print('%-24s %3d files' % (g, len(f)))

uniq = sorted(set(total))
io.open(os.path.join(out_dir, 'cairo-sources.txt'), 'w').write('\n'.join(uniq) + '\n')
print()
print('ft :', expand('cairo_ft_sources'))
print('png:', expand('cairo_png_sources'))
print('total unique to compile:', len(uniq))
