"""Check palette and exact example matrix, without third-party dependencies."""
from pathlib import Path
from collections import Counter, deque
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parent.parent
text = (ROOT / 'source/data.js').read_text(encoding='utf-8')
def array(name):
    match = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*(\[.*?\]);', text, re.S)
    assert match, name
    return json.loads(match.group(1))
palette = array('BASE_PALETTE')
codes, rows = array('VERIFIED_CODES'), array('VERIFIED_ROWS')
assert len(palette) == 221
assert len({c['code'] for c in palette}) == 221
assert all(re.fullmatch(r'#[0-9A-Fa-f]{6}', c['hex']) for c in palette)
assert len(rows) == 50 and all(len(row) == 50 for row in rows)
cells = [codes[int(symbol, 36)] for row in rows for symbol in row]
assert len(cells) == 2500 and len(set(cells)) == 12
assert set(cells).issubset({c['code'] for c in palette})
seen, queue = {0}, deque([0])
while queue:
    i = queue.popleft()
    y,x = divmod(i,50)
    for yy,xx in ((y-1,x),(y+1,x),(y,x-1),(y,x+1)):
        j = yy*50+xx
        if 0 <= yy < 50 and 0 <= xx < 50 and cells[j] and j not in seen:
            seen.add(j)
            queue.append(j)
assert len(seen) == 2500
app = (ROOT / 'source/app.js').read_text(encoding='utf-8')
assert 'CELL = 32, MARGIN = 64, MAJOR = 5' in app
edges = [64+i*32 for i in range(51)]
majors = edges[::5]
assert len(edges) == 51 and len(majors) == 11
assert all((b-a)/32 == 5 for a,b in zip(majors,majors[1:]))
assert 'ref:false,mark:false,legend:true' in app
# Peg boards sold for the two common bead sizes, and the free grid range.
assert 'BOARDS = {52:{mm:2.6},29:{mm:5}}' in app
assert 'MIN_SIDE = 5, MAX_SIDE = 156' in app
assert 'BeadQuantize.quantize(' in app
# The AI adviser is opt-in: its checkbox must ship unchecked and no key may be bundled.
html = (ROOT / 'index.html').read_text(encoding='utf-8')
assert '<input id="aiEnabled" type="checkbox">' in html
for source in ['index.html','source/app.js','source/ai.js','source/quantize.js','source/data.js']:
    assert not re.search(r'sk-[A-Za-z0-9]{16,}', (ROOT / source).read_text(encoding='utf-8')), source
for file in ['index.html','source/app.js','source/data.js','source/quantize.js','source/ai.js','source/example-loader.js']:
    assert (ROOT/file).is_file(), file
print(json.dumps({'status':'PASS','rows':50,'cols':50,'beads':len(cells),'colors':len(set(cells)),
                  'palette_colors':len(palette),'components':1,'blue_interval':5,
                  'cell_data_sha256':hashlib.sha256(json.dumps(cells,separators=(',',':')).encode()).hexdigest(),
                  'usage':dict(Counter(cells))}, ensure_ascii=False, indent=2))
print('Static/data checks only. Run `node scripts/test_quantize.js` for colour matching; browser rendering and exports require separate browser tests.')
