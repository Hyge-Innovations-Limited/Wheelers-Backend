"""Stitch each Lagos LGA's outer ways (OpenStreetMap) into closed rings, simplify, write TypeScript."""
import json, math, sys

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))

KEYS = {
    'Agege': ('agege', 'Agege'), 'Ajeromi/Ifelodun': ('ajeromi-ifelodun', 'Ajeromi-Ifelodun'),
    'Alimosho': ('alimosho', 'Alimosho'), 'Amuwo Odofin': ('amuwo-odofin', 'Amuwo-Odofin'),
    'Apapa': ('apapa', 'Apapa'), 'Badagry': ('badagry', 'Badagry'), 'Epe': ('epe', 'Epe'),
    'Eti Osa': ('eti-osa', 'Eti-Osa'), 'Ibeju Lekki': ('ibeju-lekki', 'Ibeju-Lekki'),
    'Ifako/Ijaye': ('ifako-ijaiye', 'Ifako-Ijaiye'), 'Ikeja': ('ikeja', 'Ikeja'),
    'Ìkòròdú': ('ikorodu', 'Ikorodu'), 'Kosofe': ('kosofe', 'Kosofe'), 'Mushin': ('mushin', 'Mushin'),
    'Ojo': ('ojo', 'Ojo'), 'Oshodi/Isolo': ('oshodi-isolo', 'Oshodi-Isolo'), 'Shomolu': ('shomolu', 'Shomolu'),
    'Surulere': ('surulere', 'Surulere'), 'Lagos Mainland': ('lagos-mainland', 'Lagos Mainland'),
    'Lagos Island': ('lagos-island', 'Lagos Island'),
}


def stitch(ways):
    """Join ways end to end into closed rings."""
    ways = [[(round(p['lat'], 5), round(p['lon'], 5)) for p in w] for w in ways if len(w) >= 2]
    rings = []
    while ways:
        ring = ways.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, w in enumerate(ways):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[::-1][1:]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[::-1][:-1] + ring
                else:
                    continue
                ways.pop(i)
                changed = True
                break
        rings.append(ring)
    return rings


def area(ring):
    return abs(sum(a[1] * b[0] - b[1] * a[0] for a, b in zip(ring, ring[1:] + ring[:1]))) / 2


def dp(points, tol):
    """Douglas-Peucker on an open polyline."""
    if len(points) < 3:
        return points
    (y1, x1), (y2, x2) = points[0], points[-1]
    best, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        y, x = points[i]
        num = abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1)
        den = math.hypot(y2 - y1, x2 - x1) or 1e-12
        dist = num / den if den > 1e-12 else math.hypot(y - y1, x - x1)
        if dist > best:
            best, idx = dist, i
    if best <= tol:
        return [points[0], points[-1]]
    return dp(points[: idx + 1], tol)[:-1] + dp(points[idx:], tol)


TOL = 0  # none: neighbours share their border exactly, so there is no gap between them
result = []
for e in d['elements']:
    name = e['tags']['name']
    key, label = KEYS[name]
    outer = [m['geometry'] for m in e['members'] if m['type'] == 'way' and m.get('role') == 'outer' and m.get('geometry')]
    rings = stitch(outer)
    closed = [r for r in rings if r[0] == r[-1]]
    if len(closed) != len(rings):
        print(f'{name}: {len(rings) - len(closed)} ring(s) not closed', file=sys.stderr)
    simplified = []
    for r in closed:
        s = dp(r, TOL)
        if s[0] == s[-1]:
            s = s[:-1]
        if len(s) >= 3 and area(s) > 2e-6:  # drop slivers under ~0.02 km2
            simplified.append(s)
    simplified.sort(key=area, reverse=True)
    result.append((key, label, simplified))
    print(f'{label}: {len(simplified)} part(s), {sum(len(s) for s in simplified)} corners', file=sys.stderr)

order = sorted(result, key=lambda r: r[1])
lines = [
    '/**',
    " * Lagos's 20 local government areas, for pricing (pricing-areas.ts). Outlines",
    ' * from OpenStreetMap (© OpenStreetMap contributors, ODbL), boundary relations',
    ' * admin_level 6 inside Lagos State, joined into closed shapes and simplified to',
    ' * nothing: neighbouring areas share each border exactly, so no point falls between.',
    ' * Made by a one-off script; regenerate rather than edit by hand.',
    ' */',
    '',
    "export type LgaKey =",
]
lines += [f"  | '{k}'" for k, _, _ in order]
lines[-1] += ';'
lines += ['', 'export const LGA_OUTLINES: Readonly<Record<LgaKey, { name: string; parts: ReadonlyArray<ReadonlyArray<readonly [number, number]>> }>> = {']
for key, label, parts in order:
    lines.append(f"  '{key}': {{")
    lines.append(f"    name: '{label}',")
    lines.append('    parts: [')
    for p in parts:
        lines.append('      [')
        row = []
        for lat, lng in p:
            row.append(f'[{lat:.5f}, {lng:.5f}]')
            if len(row) == 6:
                lines.append('        ' + ', '.join(row) + ',')
                row = []
        if row:
            lines.append('        ' + ', '.join(row) + ',')
        lines.append('      ],')
    lines.append('    ],')
    lines.append('  },')
lines.append('};')
open(out, 'w').write('\n'.join(lines) + '\n')
