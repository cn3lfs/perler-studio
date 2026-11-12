"""Build an offline single-file HTML and example project; Python standard library only."""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parent.parent
DATA = (ROOT / 'source/data.js').read_text(encoding='utf-8')

def array(name):
    match = re.search(r'const\s+' + re.escape(name) + r'\s*=\s*(\[.*?\]);', DATA, re.S)
    if not match:
        raise ValueError('Missing data array: ' + name)
    return json.loads(match.group(1))

palette = array('BASE_PALETTE')
codes, rows = array('VERIFIED_CODES'), array('VERIFIED_ROWS')
assert len(palette) == 221
assert len(rows) == 50 and all(len(row) == 50 for row in rows)
cells = [codes[int(symbol, 36)] for row in rows for symbol in row]
project = {
    'format':'bead-grid-studio', 'version':1,
    'state':{'cols':50,'rows':50,'mm':5,'title':'爱拼才会赢 · 50×50 校验版',
             'majorStyle':'solid','cells':cells,'paletteStatus':'community','revision':1},
    'palette':{'id':'mard-221','status':'community','attribution':'Color data: craft-color-codes by MakeBead',
               'license':'CC-BY-4.0','colors':palette},
    'reference':None
}
html = (ROOT / 'index.html').read_text(encoding='utf-8')
for name in ['data.js', 'app.js', 'example-loader.js']:
    marker = '<script src="source/' + name + '"></script>'
    assert html.count(marker) == 1, marker
    code = (ROOT / 'source' / name).read_text(encoding='utf-8')
    html = html.replace(marker, '<script>\n' + code.replace('</script', '<\\/script') + '\n</script>')
out = ROOT / 'dist'
out.mkdir(exist_ok=True)
(out / 'perler-studio.html').write_text(html, encoding='utf-8')
(out / 'aipin_verified_project.json').write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding='utf-8')
print('Built dist/perler-studio.html and dist/aipin_verified_project.json')
