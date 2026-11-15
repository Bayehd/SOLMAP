# Wheels-only copy of the rover model, for the Rover view (riding on the rover you see its wheels, not the rest).
# Reads public/models/perseverance.glb, keeps the "Wheels_objs" part with the transforms above it, drops everything
# else (meshes, materials, textures, buffer data no longer used) and writes public/models/perseverance-wheels.glb.
# Prints the size of the wheels and of the whole rover in model units, for scaling in src/map/rover.ts.
# usage: python scripts/make_wheels_model.py
import json
import struct
from pathlib import Path

import numpy as np

SRC = Path('public/models/perseverance.glb')
DST = Path('public/models/perseverance-wheels.glb')
KEEP = 'Wheels_objs'


def read_glb(path):
    b = path.read_bytes()
    n = struct.unpack('<I', b[12:16])[0]
    gltf = json.loads(b[20 : 20 + n])
    off = 20 + n
    blen = struct.unpack('<I', b[off : off + 4])[0]
    return gltf, b[off + 8 : off + 8 + blen]


def node_matrix(n):
    if 'matrix' in n:
        return np.array(n['matrix'], dtype=float).reshape(4, 4).T
    t = np.eye(4)
    if 'translation' in n:
        t[:3, 3] = n['translation']
    r = np.eye(4)
    if 'rotation' in n:
        x, y, z, w = n['rotation']
        r[:3, :3] = [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    s = np.eye(4)
    if 'scale' in n:
        s[0, 0], s[1, 1], s[2, 2] = n['scale']
    return t @ r @ s


def bounds(gltf, roots):
    """World-space bounding box of the meshes under these nodes (from accessor min/max corners)."""
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)

    def walk(i, m):
        n = gltf['nodes'][i]
        m = m @ node_matrix(n)
        if 'mesh' in n:
            for p in gltf['meshes'][n['mesh']]['primitives']:
                a = gltf['accessors'][p['attributes']['POSITION']]
                for c in np.array(np.meshgrid(*zip(a['min'], a['max']))).T.reshape(-1, 3):
                    w = (m @ np.append(c, 1))[:3]
                    lo[:] = np.minimum(lo, w)
                    hi[:] = np.maximum(hi, w)
        for c in n.get('children', []):
            walk(c, m)

    for r in roots:
        walk(r, np.eye(4))
    return lo, hi


gltf, binary = read_glb(SRC)
scene = gltf['scenes'][gltf.get('scene', 0)]
parents = {c: i for i, n in enumerate(gltf['nodes']) for c in n.get('children', [])}
keep_node = next(i for i, n in enumerate(gltf['nodes']) if n.get('name', '').startswith(KEEP))
full_lo, full_hi = bounds(gltf, scene['nodes'])

# Path from the scene root down to the wheels: those nodes keep only the child on the path.
path = [keep_node]
while path[-1] in parents:
    path.append(parents[path[-1]])
path.reverse()
for a, b in zip(path, path[1:]):
    gltf['nodes'][a]['children'] = [b]
scene['nodes'] = [path[0]]

# Renumber everything still used.
used_nodes = []


def collect(i):
    used_nodes.append(i)
    for c in gltf['nodes'][i].get('children', []):
        collect(c)


collect(path[0])
node_map = {o: n for n, o in enumerate(used_nodes)}
mesh_ids = sorted({gltf['nodes'][i]['mesh'] for i in used_nodes if 'mesh' in gltf['nodes'][i]})
mesh_map = {o: n for n, o in enumerate(mesh_ids)}
acc_ids, mat_ids = set(), set()
for m in mesh_ids:
    for p in gltf['meshes'][m]['primitives']:
        acc_ids.update(p['attributes'].values())
        if 'indices' in p:
            acc_ids.add(p['indices'])
        if 'material' in p:
            mat_ids.add(p['material'])
acc_ids, mat_ids = sorted(acc_ids), sorted(mat_ids)
acc_map = {o: n for n, o in enumerate(acc_ids)}
mat_map = {o: n for n, o in enumerate(mat_ids)}

tex_ids = set()


def find_textures(o):
    if isinstance(o, dict):
        if 'index' in o and isinstance(o['index'], int) and ('texCoord' in o or len(o) <= 3):
            tex_ids.add(o['index'])
        for v in o.values():
            find_textures(v)
    elif isinstance(o, list):
        for v in o:
            find_textures(v)


for m in mat_ids:
    find_textures(gltf['materials'][m])
tex_ids = sorted(tex_ids)
tex_map = {o: n for n, o in enumerate(tex_ids)}
img_ids = sorted({gltf['textures'][t]['source'] for t in tex_ids})
img_map = {o: n for n, o in enumerate(img_ids)}
view_ids = sorted({gltf['accessors'][a]['bufferView'] for a in acc_ids} | {gltf['images'][i]['bufferView'] for i in img_ids})

# New binary buffer with only the used views (4-byte aligned).
out_bin = bytearray()
view_map = {}
new_views = []
for v in view_ids:
    bv = dict(gltf['bufferViews'][v])
    data = binary[bv.get('byteOffset', 0) : bv.get('byteOffset', 0) + bv['byteLength']]
    while len(out_bin) % 4:
        out_bin.append(0)
    bv['byteOffset'] = len(out_bin)
    bv['buffer'] = 0
    out_bin += data
    view_map[v] = len(new_views)
    new_views.append(bv)


def remap_tex(o):
    if isinstance(o, dict):
        if 'index' in o and isinstance(o['index'], int) and o['index'] in tex_map and ('texCoord' in o or len(o) <= 3):
            o['index'] = tex_map[o['index']]
        for v in o.values():
            remap_tex(v)
    elif isinstance(o, list):
        for v in o:
            remap_tex(v)


nodes = []
for o in used_nodes:
    n = dict(gltf['nodes'][o])
    if 'children' in n:
        n['children'] = [node_map[c] for c in n['children']]
    if 'mesh' in n:
        n['mesh'] = mesh_map[n['mesh']]
    nodes.append(n)
meshes = []
for m in mesh_ids:
    mesh = json.loads(json.dumps(gltf['meshes'][m]))
    for p in mesh['primitives']:
        p['attributes'] = {k: acc_map[v] for k, v in p['attributes'].items()}
        if 'indices' in p:
            p['indices'] = acc_map[p['indices']]
        if 'material' in p:
            p['material'] = mat_map[p['material']]
    meshes.append(mesh)
accessors = []
for a in acc_ids:
    acc = dict(gltf['accessors'][a])
    acc['bufferView'] = view_map[acc['bufferView']]
    accessors.append(acc)
materials = [json.loads(json.dumps(gltf['materials'][m])) for m in mat_ids]
remap_tex(materials)
textures = [dict(gltf['textures'][t], source=img_map[gltf['textures'][t]['source']]) for t in tex_ids]
images = [dict(gltf['images'][i], bufferView=view_map[gltf['images'][i]['bufferView']]) for i in img_ids]

out = {k: v for k, v in gltf.items() if k in ('asset', 'extensionsUsed', 'samplers')}
out.update(
    scene=0,
    scenes=[{'nodes': [0]}],
    nodes=nodes,
    meshes=meshes,
    accessors=accessors,
    bufferViews=new_views,
    buffers=[{'byteLength': len(out_bin)}],
    materials=materials,
)
if textures:
    out.update(textures=textures, images=images)

js = json.dumps(out, separators=(',', ':')).encode()
js += b' ' * (-len(js) % 4)
out_bin += b'\0' * (-len(out_bin) % 4)
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out_bin))
glb += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(out_bin), 0x004E4942) + bytes(out_bin)
DST.write_bytes(glb)

wheel_lo, wheel_hi = bounds(out, [0])
print(f'{DST}: {len(glb) / 1e6:.2f} MB, {len(nodes)} nodes, {len(meshes)} meshes')
print('glTF axes: x, y (up), z')
print('rover  min', full_lo.round(3), 'max', full_hi.round(3), 'size', (full_hi - full_lo).round(3))
print('wheels min', wheel_lo.round(3), 'max', wheel_hi.round(3), 'size', (wheel_hi - wheel_lo).round(3))
