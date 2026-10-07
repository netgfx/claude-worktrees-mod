import sys
from html import escape

W, H = 1440, 900
FONT = "'Cascadia Mono','Cascadia Code',Consolas,'SF Mono',Menlo,monospace"
CW = 8.4  # char width at 14px
LH = 20
# usage: python mockup.py <out.svg> [dark|light]
THEME = sys.argv[2] if len(sys.argv) > 2 else 'dark'
if THEME == 'light':
    BG, PANEL, FG, DIM = '#ffffff', '#f6f8fa', '#1f2328', '#656d76'
    CYAN, GREEN, YELLOW, RED = '#0969da', '#1a7f37', '#9a6700', '#cf222e'
    BAR, LINE, BTN = '#eaeef2', '#d0d7de', '#f3f4f6'
else:
    BG, PANEL, FG, DIM = '#0d1117', '#11161d', '#e6edf3', '#7d8590'
    CYAN, GREEN, YELLOW, RED = '#56d4dd', '#7ee787', '#e3b341', '#ff7b72'
    BAR, LINE, BTN = '#161b22', '#30363d', '#21262d'
SKY, AMBER, LGREEN, PINK = '#4FC3F7', '#FFB74D', '#81C784', '#F06292'

out = []


def t(x, y, parts, size=14):
    """parts: list of (text, color, extra-attrs)"""
    spans = ''.join(
        f'<tspan fill="{c}"{(" " + a) if a else ""}>{escape(s)}</tspan>' for s, c, *rest in parts for a in [rest[0] if rest else '']
    )
    out.append(f'<text x="{x}" y="{y}" font-size="{size}" xml:space="preserve">{spans}</text>')


def button(x, y, label, primary=False, plain=False):
    w = len(label) * CW + (0 if plain else 16)
    if plain:
        t(x, y, [(label, FG, 'text-decoration="underline"')])
    else:
        fill = '#1f6feb' if primary else BTN
        stroke = '#388bfd' if primary else LINE
        out.append(f'<rect x="{x}" y="{y - 15}" width="{w}" height="21" rx="4" fill="{fill}" stroke="{stroke}"/>')
        t(x + 8, y, [(label, '#ffffff' if primary else FG)])
    return x + w + (14 if plain else 8)


# window
out.append(f'<rect width="{W}" height="{H}" rx="10" fill="{BG}"/>')
out.append(f'<rect width="{W}" height="36" rx="10" fill="{BAR}"/><rect y="26" width="{W}" height="10" fill="{BAR}"/>')
for i, c in enumerate(['#ff5f57', '#febc2e', '#28c840']):
    out.append(f'<circle cx="{20 + i * 20}" cy="18" r="6" fill="{c}"/>')
t(W / 2 - 160, 23, [('claude — shop-app.worktrees/oauth-login', DIM)], 13)

# ---------- left: the Claude session ----------
L = 28
y = 76
t(L, y, [('> ', DIM), ('start the dev server and check the login page renders', FG)]); y += LH * 2
t(L, y, [('● ', GREEN), ('Bash', FG, 'font-weight="bold"'), ('(npx vite --port 5173)', FG)]); y += LH
t(L, y, [('  ⎿  ', DIM), ('Error: Port 5173 is not one of this worktree\'s ports, and the', RED)]); y += LH
for line in [
    'default dev ports collide between worktrees. This worktree',
    '("oauth-login") owns ports 4110-4119 and PORT=4110 is set in',
    'the environment. Run the dev server on 4110 (use 4111-4119 for',
    'extra services), e.g. `vite --port 4110 --strictPort`.',
]:
    t(L, y, [('     ', DIM), (line, RED)]); y += LH
y += LH
t(L, y, [('● ', GREEN), ('Bash', FG, 'font-weight="bold"'), ('(npx vite --port 4110 --strictPort)', FG)]); y += LH
t(L, y, [('  ⎿  ', DIM), ('VITE v6.2.0  ready in 412 ms', GREEN)]); y += LH
t(L, y, [('     ➜  Local:   ', DIM), ('http://localhost:4110/', CYAN)]); y += LH * 2
t(L, y, [('● ', FG), ('Bash', FG, 'font-weight="bold"'), ('(curl -s localhost:4110/login | head -5)', FG)]); y += LH
t(L, y, [('  ⎿  ', DIM), ('&lt;title&gt;Sign in · Shop&lt;/title&gt;'.replace('&lt;', '<').replace('&gt;', '>'), DIM)]); y += LH * 2
t(L, y, [('● ', FG), ('The dev server is up on ', FG), ('http://localhost:4110', CYAN), (' — this worktree\'s own', FG)]); y += LH
t(L, y, [('  port, so it doesn\'t collide with checkout-bug or main (:4100).', FG)]); y += LH
t(L, y, [('  The login page renders with the new "Continue with Google" button.', FG)]); y += LH

# prompt box + status line
py = H - 110
out.append(f'<rect x="{L - 8}" y="{py}" width="770" height="38" rx="6" fill="none" stroke="{LINE}"/>')
t(L + 4, py + 24, [('> ', DIM), ('│', FG)])
t(L, py + 62, [('⎇ oauth-login · feat/oauth-login · :4110 · Add OAuth login to the settings page', AMBER)], 13)
t(L, py + 84, [('? for shortcuts', DIM)], 13)

# ---------- right: the Worktrees pane ----------
PX = 830
out.append(f'<rect x="{PX}" y="36" width="{W - PX}" height="{H - 36}" fill="{PANEL}"/>')
out.append(f'<line x1="{PX}" y1="36" x2="{PX}" y2="{H}" stroke="{LINE}"/>')
out.append(f'<rect x="{PX}" y="36" width="{W - PX}" height="30" fill="{BAR}"/>')
t(PX + 16, 56, [('Worktrees', FG, 'font-weight="bold"'), ('   esc to close', DIM)], 13)

X = PX + 18
y = 92
t(X, y, [('⎇ shop-app', FG, 'font-weight="bold"'), (' · 4 worktrees · 2 serving', DIM)]); y += LH
t(X, y, [('this session: ', DIM), ('● oauth-login :4110', AMBER, 'font-weight="bold"')]); y += LH + 12
bx = button(X, y, 'New worktree (n)', primary=True)
bx = button(bx + 6, y, 'Port guard: on (g)', plain=True)
button(bx, y, 'r', plain=True)
y += 22

cards = [
    dict(color=SKY, name='shop-app', main=True, here=False, branch='main', sync=('↑0', '↓0'), changes=None, last='2 hours ago',
         task='Release prep for v2.4', ports='4100-4109', live=[4100], path='shop-app'),
    dict(color=AMBER, name='oauth-login', main=False, here=True, branch='feat/oauth-login', sync=('↑3', '↓0'), changes=5, last='4 minutes ago',
         task='Add OAuth login to the settings page', ports='4110-4119', live=[4110, 4111], path='shop-app.worktrees/oauth-login'),
    dict(color=LGREEN, name='checkout-bug', main=False, here=False, branch='fix/checkout-total', sync=None, changes=2, last='1 hour ago',
         task='Fix rounding in the checkout total', ports='4120-4129', live=[], path='shop-app.worktrees/checkout-bug'),
    dict(color=PINK, name='dark-mode', main=False, here=False, branch='feat/dark-mode', sync=('↑1', '↓2'), changes=None, last='yesterday',
         task='Add a dark theme toggle to the header', ports='4130-4139', live=[], path='shop-app.worktrees/dark-mode'),
]
CWID = W - PX - 36
for c in cards:
    rows = 6
    h = rows * LH + 22
    y += 14
    sw = 3 if c['here'] else 1.5
    out.append(f'<rect x="{X - 6}" y="{y}" width="{CWID}" height="{h}" rx="8" fill="none" stroke="{c["color"]}" stroke-width="{sw}"/>')
    ry = y + 22
    parts = [('● ', c['color'], 'font-weight="bold"'), (c['name'], c['color'], 'font-weight="bold"')]
    if c['main']:
        parts.append(('  main', DIM))
    t(X + 6, ry, parts)
    if c['here']:
        t(X + CWID - 140, ry, [('◆ this session', c['color'], 'font-weight="bold"')])
    else:
        button(X + CWID - 82, ry, 'Switch')
    ry += LH
    parts = [(c['branch'], CYAN)]
    if c['sync']:
        a, b = c['sync']
        parts += [('  ' + a, GREEN if a != '↑0' else DIM), (' ' + b, RED if b != '↓0' else DIM)]
    parts += [('  ~%d changed' % c['changes'], YELLOW) if c['changes'] else ('  ✓ clean', GREEN), ('  · ' + c['last'], DIM)]
    t(X + 6, ry, parts); ry += LH
    t(X + 6, ry, [(c['task'], FG, 'font-style="italic"')]); ry += LH
    parts = [('ports ' + c['ports'] + '  ', DIM)]
    if c['live']:
        for p in c['live']:
            parts.append(('● :%d' % p, GREEN, 'text-decoration="underline"'))
            parts.append(('  ', DIM))
    else:
        parts.append(('○ idle', DIM))
    t(X + 6, ry, parts); ry += LH
    t(X + 6, ry, [(c['path'], DIM)]); ry += LH
    bx = X + 6
    for lab in ['Terminal', 'Editor', 'Copy cd', 'Edit', 'Suggest'] + ([] if c['main'] or c['here'] else ['Remove']):
        bx = button(bx, ry, lab, plain=True)
    y += h

y += 36
out.append(f'<line x1="{X}" y1="{y - 14}" x2="{X + CWID - 6}" y2="{y - 14}" stroke="{LINE}"/>')
t(X, y, [('Each worktree owns 10 ports; Claude\'s shells get PORT for', DIM)], 13); y += 18
t(X, y, [('the session\'s worktree. Names, tasks and ports live in git', DIM)], 13); y += 18
t(X, y, [('config (wtmod.*).', DIM)], 13)

svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}">\n'
    + '\n'.join(out)
    + '\n</svg>\n'
)
open(sys.argv[1], 'w', encoding='utf-8', newline='\n').write(svg)
