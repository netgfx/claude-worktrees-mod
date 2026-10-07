// worktrees-manager-mod: a /worktrees side panel for every worktree of the
// repository the session runs in. Each worktree gets a name, a color, a
// one-sentence task and a block of dev-server ports, kept in the repository's
// own git config (`wtmod.<id>.*`) so every terminal and session sees the same.
// The session's own worktree: PORT is set for every shell Claude starts, the
// system prompt names the worktree, its task and its ports, and a dev-server
// command that would take another worktree's port is refused with the fix.
// Switching runs Claude Code's EnterWorktree tool, so no branch is checked out
// over another. Helpers that take $ are top-level functions: static analysis
// refuses $ passed to nested or imported functions.

const PANE = 'worktrees'
const MODEL = 'haiku' // model for branch names and task summaries
const POLL_MS = 4000 // refresh interval while the panel is open
const SECTION = 'wtmod' // git config section: wtmod.<worktree id>.<field>
const MAIN_ID = '(main)' // config id of the main worktree (git ids come from folder names)
const PORT_BASE = 4100 // first port block; clear of 3000, 5173, 8000 and 8080
const PORT_BLOCK = 10 // ports per worktree: PORT, then PORT+1..PORT+9 for extra services
const PORT_LIMIT = 9999
const STORE_PORT = 'port:' // $.store key prefix: machine-wide port block registry
const STORE_GUARD = 'guard' // $.store key: port guard on/off
const PROMPT_ID = 'worktrees-manager-mod:worktree'
const SHELL_TOOLS = ['Bash', 'PowerShell']
const SWITCH_TOOLS = ['EnterWorktree', 'ExitWorktree']
const ENV_FILE = /^\.env(\..+)?$/

const PALETTE = [
  { hex: '#4FC3F7', name: 'sky' },
  { hex: '#FFB74D', name: 'amber' },
  { hex: '#81C784', name: 'green' },
  { hex: '#F06292', name: 'pink' },
  { hex: '#BA68C8', name: 'violet' },
  { hex: '#FFF176', name: 'yellow' },
  { hex: '#4DB6AC', name: 'teal' },
  { hex: '#E57373', name: 'red' },
  { hex: '#7986CB', name: 'indigo' },
  { hex: '#AED581', name: 'lime' },
  { hex: '#FF8A65', name: 'coral' },
  { hex: '#A1887F', name: 'brown' },
]

// Dev servers, and the ones among them that ignore the PORT variable
const DEV_RE =
  /\b(vite|next\s+(dev|start)|nuxt|nuxi\s+dev|astro\s+(dev|preview)|ng\s+serve|webpack(-dev-server|\s+serve)|storybook|start-storybook|remix\s+dev|react-scripts\s+start|gatsby\s+develop|http-server|live-server|serve|http\.server|runserver|uvicorn|gunicorn|flask\s+run|rails\s+(s|server)|hugo\s+server|jekyll\s+serve|nodemon|(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview))\b/i
const NEEDS_FLAG_RE =
  /\b(vite|ng\s+serve|webpack(-dev-server|\s+serve)|storybook|start-storybook|astro\s+(dev|preview)|http-server|live-server|http\.server|runserver|uvicorn|flask\s+run|hugo\s+server|jekyll\s+serve)\b/i
const PORT_REF_RE = /\$\{?PORT\b|%PORT%|\$env:PORT\b/i
const PORT_PATTERNS = [
  /--port(?:=|\s+)['"]?(\d{2,5})\b/gi,
  /(?:^|\s)-p(?:=|\s+)?['"]?(\d{2,5})\b/g,
  /\bPORT\s*=\s*['"]?(\d{2,5})\b/g,
  /--listen(?:=|\s+)(?:\S*:)?(\d{2,5})\b/gi,
  /--bind(?:=|\s+)\S*:(\d{2,5})\b/gi,
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi,
  /\bhttp\.server\s+(\d{2,5})\b/g,
  /\brunserver\s+(?:[\d.]+:)?(\d{2,5})\b/g,
]

// Module state: rebuilt by the next refresh after a hot reload
let paneOpen = false
let refreshing = false
let loaded = false
let platform = '' // 'windows' | 'mac' | 'linux'
let gitVersion = [0, 0]
let repo = null // { error } | { mainRoot, name }
let trees = [] // see readTrees
let current = null // the tree this session runs in
let listening = new Set()
let registry = [] // { port, root, id, path, name }
let lastSig = ''
let busy = '' // label of the running action, '' when idle
let notice = null // { tone, text, path? }
let form = null // { mode: 'new', task, base } | { mode: 'edit', id, name, task, color, port }
let confirm = '' // 'remove:<id>' | 'force:<id>'
let guardOn = true
let envSig = ''
let promptText = ''
const idCache = new Map() // worktree path -> git id
const summarised = new Set() // worktree ids whose task was written from a prompt

// ---------- pure helpers (exported for tests) ----------

export function norm(p) {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:/.test(s)) s = s.toLowerCase()
  return s
}

function baseName(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return s.slice(s.lastIndexOf('/') + 1)
}

function parentDir(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return s.slice(0, s.lastIndexOf('/'))
}

export function parseWorktrees(out) {
  const list = []
  let cur = null
  for (const tok of out.split('\0')) {
    if (!tok) {
      if (cur) list.push(cur)
      cur = null
      continue
    }
    const sp = tok.indexOf(' ')
    const k = sp < 0 ? tok : tok.slice(0, sp)
    const v = sp < 0 ? '' : tok.slice(sp + 1)
    if (k === 'worktree') {
      if (cur) list.push(cur)
      cur = { path: v, head: '', branch: '', isBare: false, isDetached: false, locked: '', prunable: '' }
    } else if (!cur) continue
    else if (k === 'HEAD') cur.head = v
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '')
    else if (k === 'bare') cur.isBare = true
    else if (k === 'detached') cur.isDetached = true
    else if (k === 'locked') cur.locked = v || 'locked'
    else if (k === 'prunable') cur.prunable = v || 'its folder is gone'
  }
  if (cur) list.push(cur)
  return list.map((t, i) => ({ ...t, isMain: i === 0 }))
}

// `git config -z --get-regexp ^wtmod\.` -> { [id]: { name, color, task, port } }
export function parseMeta(out) {
  const meta = {}
  for (const rec of out.split('\0')) {
    if (!rec.startsWith(SECTION + '.')) continue
    const nl = rec.indexOf('\n')
    const key = nl < 0 ? rec : rec.slice(0, nl)
    const value = nl < 0 ? '' : rec.slice(nl + 1)
    const rest = key.slice(SECTION.length + 1)
    const dot = rest.lastIndexOf('.')
    if (dot <= 0) continue
    const id = rest.slice(0, dot)
    const field = rest.slice(dot + 1)
    meta[id] = meta[id] ?? {}
    meta[id][field] = field === 'port' ? Number(value) || 0 : value
  }
  return meta
}

export function parseStatusCounts(out) {
  const info = { changed: 0, ahead: 0, behind: 0, upstream: '' }
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    if (t.startsWith('# branch.upstream ')) info.upstream = t.slice(18)
    else if (t.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(t)
      if (m) {
        info.ahead = Number(m[1])
        info.behind = Number(m[2])
      }
    } else if (t[0] === '1' || t[0] === 'u' || t[0] === '?') info.changed++
    else if (t[0] === '2') {
      info.changed++
      i++ // the rename's original path
    }
  }
  return info
}

// Listening TCP ports from netstat (Windows), lsof (macOS) or ss (Linux)
export function parseListening(text) {
  const ports = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    const m =
      /^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\b/i.exec(line) ??
      /TCP\s+\S*:(\d+)\s+\(LISTEN\)/.exec(line) ??
      /^LISTEN\s+\d+\s+\d+\s+\S*:(\d+)\s/.exec(line)
    if (m) ports.add(Number(m[1]))
  }
  return ports
}

export function pickPortBlock(used, busyPorts) {
  for (let p = PORT_BASE; p + PORT_BLOCK - 1 <= PORT_LIMIT; p += PORT_BLOCK) {
    if (used.has(p)) continue
    let taken = false
    for (let q = p; q < p + PORT_BLOCK; q++) if (busyPorts.has(q)) taken = true
    if (!taken) return p
  }
  return 0
}

export function pickColor(usedColors) {
  const used = new Set([...usedColors].map((c) => String(c).toUpperCase()))
  const free = PALETTE.find((c) => !used.has(c.hex))
  return (free ?? PALETTE[used.size % PALETTE.length]).hex
}

export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '')
}

export function cleanSentence(text, max) {
  const line = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0]
  if (!line) return ''
  const s = line.replace(/^["'`*]+|["'`*]+$/g, '').trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

export function parseBranchName(text) {
  const m = /([a-z]+)\/([a-z0-9][a-z0-9-]{1,48})/.exec(String(text ?? '').toLowerCase())
  return m ? m[1] + '/' + m[2].replace(/-+$/, '') : ''
}

export function findPorts(cmd) {
  const found = []
  for (const re of PORT_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(cmd))) {
      const n = Number(m[1])
      if (n >= 1 && n <= 65535 && !found.includes(n)) found.push(n)
    }
  }
  return found
}

function inBlock(p, start) {
  return start > 0 && p >= start && p < start + PORT_BLOCK
}

// The port guard's decision for one shell command: null to let it run, or the
// instruction Claude reads when it is refused.
//   own: { name, port }, others: [{ name, port, path }], script: the npm script it runs
export function checkDevCommand(cmd, own, others, script) {
  if (!own?.port) return null
  const body = script ?? ''
  if (!DEV_RE.test(cmd) && !DEV_RE.test(body)) return null
  const range = own.port + '-' + (own.port + PORT_BLOCK - 1)
  const fix =
    'This worktree ("' + own.name + '") owns ports ' + range + ' and PORT=' + own.port + ' is set in the environment. ' +
    'Run the dev server on ' + own.port + ' (use ' + (own.port + 1) + '-' + (own.port + PORT_BLOCK - 1) + ' for extra services), ' +
    'e.g. `vite --port ' + own.port + ' --strictPort`, `npm run dev -- --port ' + own.port + '` or `next dev -p ' + own.port + '`.'
  for (const p of findPorts(cmd)) {
    if (inBlock(p, own.port)) continue
    const other = others.find((o) => inBlock(p, o.port))
    return other
      ? 'Port ' + p + ' belongs to the worktree "' + other.name + '" (' + other.path + '), which runs in parallel; starting a server there collides with it. ' + fix
      : 'Port ' + p + ' is not one of this worktree\'s ports, and the default dev ports collide between worktrees. ' + fix
  }
  if (findPorts(cmd).length || PORT_REF_RE.test(cmd)) return null
  const hard = findPorts(body).filter((p) => !inBlock(p, own.port))
  if (hard.length) {
    return 'The script this command runs hard-codes port ' + hard[0] + ', which collides between worktrees. Run the underlying command yourself with this worktree\'s port. ' + fix
  }
  if (NEEDS_FLAG_RE.test(cmd) || (NEEDS_FLAG_RE.test(body) && !PORT_REF_RE.test(body))) {
    return 'This dev server ignores the PORT variable, so it would start on its default port and collide with other worktrees. Pass the port explicitly. ' + fix
  }
  return null
}

export function scriptName(cmd) {
  const m = /\b(npm|pnpm|yarn|bun)\s+(run\s+|run-script\s+)?([\w:.-]+)/.exec(cmd)
  if (!m) return ''
  if (m[1] === 'npm' && !m[2] && !['start', 'test'].includes(m[3])) return ''
  return m[3]
}

export function buildPrompt(tree, all) {
  if (!tree) return ''
  const m = tree.meta
  const lines = [
    '# Git worktree',
    'This session works in the git worktree "' + m.name + '" at ' + tree.path + (tree.branch ? ' (branch ' + tree.branch + ')' : '') + '.',
  ]
  if (m.task) lines.push('Its task: ' + m.task)
  const others = all.filter((t) => t !== tree && !t.isBare && !t.prunable)
  if (others.length) {
    lines.push(
      'Other worktrees of this repository are in use in parallel, possibly by other agents. Do not edit files in them, check out their branches, or run commands in them; stay in ' + tree.path + '.',
    )
    for (const o of others) {
      lines.push(
        '- "' + o.meta.name + '" ' + (o.branch || 'detached') + ' at ' + o.path + (o.meta.port ? ', ports ' + o.meta.port + '-' + (o.meta.port + PORT_BLOCK - 1) : '') + (o.meta.task ? ': ' + o.meta.task : ''),
      )
    }
  }
  if (m.port) {
    const last = m.port + PORT_BLOCK - 1
    lines.push(
      '',
      'Dev servers: this worktree owns ports ' + m.port + '-' + last + '. PORT=' + m.port + ' is set in the environment of every shell you start.',
      '- Start the main dev server on ' + m.port + ' (http://localhost:' + m.port + ') and use ' + (m.port + 1) + '-' + last + ' for extra local services (API, Storybook, ...).',
      '- Pass the port explicitly to tools that ignore PORT: `vite --port ' + m.port + ' --strictPort`, `npm run dev -- --port ' + m.port + '`, `ng serve --port ' + m.port + '`, `next dev -p ' + m.port + '`, `python -m http.server ' + m.port + '`.',
      '- Never use another worktree\'s ports or a default port such as 3000, 5173, 8000 or 8080; a dev-server command that does is refused.',
    )
  }
  return lines.join('\n')
}

// ---------- git and processes ----------

async function git($, args, init) {
  const opts = init ?? {}
  try {
    const r = await $.process.run(['git', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
      timeoutMs: opts.timeoutMs ?? 20000,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    return {
      ok: r.exitCode === 0,
      out: String(r.stdout ?? '').replace(/\r\n/g, '\n'),
      err: String(r.stderr ?? '').replace(/\r\n/g, '\n').trim(),
    }
  } catch (err) {
    return { ok: false, out: '', err: 'git could not start: ' + (err?.message ?? err), isMissing: true }
  }
}

async function gitMain($, args, init) {
  return git($, args, { ...(init ?? {}), cwd: repo?.mainRoot })
}

async function run($, argv, timeoutMs) {
  try {
    const r = await $.process.run(argv, { timeoutMs: timeoutMs ?? 15000 })
    return { ok: r.exitCode === 0, out: String(r.stdout ?? ''), err: String(r.stderr ?? '').trim() }
  } catch (err) {
    return { ok: false, out: '', err: String(err?.message ?? err), isMissing: true }
  }
}

async function detectPlatform($, cwd) {
  if (platform) return platform
  if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')) {
    platform = 'windows'
  } else {
    const r = await run($, ['uname', '-s'], 5000)
    platform = /darwin/i.test(r.out) ? 'mac' : 'linux'
  }
  return platform
}

function nativePath(p) {
  return platform === 'windows' ? String(p).replace(/\//g, '\\') : String(p)
}

async function scanPorts($) {
  let r
  if (platform === 'windows') r = await run($, ['netstat', '-ano', '-p', 'TCP'])
  else {
    r = await run($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN'])
    if (r.isMissing) r = await run($, ['ss', '-ltnH'])
  }
  const next = parseListening(r.out)
  if (platform === 'windows') {
    const v6 = await run($, ['netstat', '-ano', '-p', 'TCPv6'])
    for (const p of parseListening(v6.out)) next.add(p)
  }
  listening = next
}

// ---------- the machine-wide port registry ($.store) ----------

async function loadRegistry($) {
  const list = []
  try {
    const keys = await $.store.keys()
    for (const key of keys) {
      if (!key.startsWith(STORE_PORT)) continue
      const v = await $.store.get(key)
      if (v && typeof v === 'object') list.push({ ...v, port: Number(key.slice(STORE_PORT.length)) })
    }
  } catch (err) {
    $.ui.log('worktrees-manager-mod: could not read the port registry: ' + (err?.message ?? err), { to: 'debug' })
  }
  registry = list
}

async function claimPort($, tree, port) {
  const entry = { root: norm(repo.mainRoot), id: tree.id, path: tree.path, name: tree.meta.name, repo: repo.name }
  try {
    await $.store.set(STORE_PORT + port, entry)
  } catch (err) {
    $.ui.log('worktrees-manager-mod: could not record port ' + port + ': ' + (err?.message ?? err), { to: 'debug' })
  }
  registry = [...registry.filter((r) => r.port !== port), { ...entry, port }]
}

async function releasePort($, port) {
  if (!port) return
  try {
    await $.store.delete(STORE_PORT + port)
  } catch {
    // already gone
  }
  registry = registry.filter((r) => r.port !== port)
}

// Drops registry entries whose worktree is gone
async function collectGarbage($) {
  const root = norm(repo.mainRoot)
  for (const r of [...registry]) {
    let isGone
    if (r.root === root) isGone = !trees.some((t) => t.id === r.id && t.meta.port === r.port)
    else isGone = !(await $.fs.exists(r.path).catch(() => true))
    if (isGone) await releasePort($, r.port)
  }
}

// ---------- reading the worktrees ----------

async function setMeta($, id, field, value) {
  const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  const key = SECTION + '.' + id + '.' + field
  const r = clean ? await gitMain($, ['config', key, clean]) : await gitMain($, ['config', '--unset', key])
  if (!r.ok && clean) throw new Error('git config ' + key + ': ' + r.err)
}

async function readTree($, t, meta) {
  let id = t.isMain ? MAIN_ID : idCache.get(t.path) ?? ''
  if (!id && !t.prunable) {
    const r = await git($, ['rev-parse', '--absolute-git-dir'], { cwd: t.path })
    if (r.ok) id = baseName(r.out.trim())
  }
  if (!id) id = baseName(t.path)
  if (!t.isMain) idCache.set(t.path, id)
  const m = meta[id] ?? {}
  const tree = {
    ...t,
    id,
    meta: {
      name: m.name || (t.isMain ? repo.name : baseName(t.path)),
      color: m.color || '',
      task: m.task || '',
      port: m.port || 0,
    },
    status: { changed: 0, ahead: 0, behind: 0, upstream: '', last: '' },
  }
  if (t.isBare || t.prunable) return tree
  const [st, log] = await Promise.all([
    git($, ['status', '--porcelain=v2', '--branch', '-z'], { cwd: t.path }),
    git($, ['log', '-1', '--format=%cr'], { cwd: t.path }),
  ])
  if (st.ok) tree.status = { ...parseStatusCounts(st.out), last: log.ok ? log.out.trim() : '' }
  return tree
}

// Gives every worktree a color and a port block it does not share
async function ensureMeta($) {
  const root = norm(repo.mainRoot)
  const missing = trees.filter((t) => !t.isBare && !t.prunable && (!t.meta.color || !t.meta.port))
  const clash = trees.filter((t) => {
    if (!t.meta.port) return false
    const owner = registry.find((r) => r.port === t.meta.port)
    return owner && (owner.root !== root || owner.id !== t.id)
  })
  if (!missing.length && !clash.length) {
    // Re-record blocks the store forgot (it drops keys unused for a while)
    for (const t of trees) if (t.meta.port && !registry.some((r) => r.port === t.meta.port)) await claimPort($, t, t.meta.port)
    return
  }
  await scanPorts($)
  for (const t of [...missing, ...clash]) {
    if (!t.meta.color) {
      t.meta.color = pickColor(trees.map((o) => o.meta.color).filter(Boolean))
      await setMeta($, t.id, 'color', t.meta.color).catch(() => {})
    }
    const owner = t.meta.port ? registry.find((r) => r.port === t.meta.port) : null
    if (!t.meta.port || (owner && (owner.root !== root || owner.id !== t.id))) {
      const used = new Set([...registry.map((r) => r.port), ...trees.filter((o) => o !== t).map((o) => o.meta.port)])
      const port = pickPortBlock(used, listening)
      if (!port) continue
      t.meta.port = port
      await setMeta($, t.id, 'port', String(port)).catch(() => {})
      await claimPort($, t, port)
    }
  }
}

async function applySession($) {
  if (!current?.meta.port) {
    if (envSig) {
      await $.env.set('PORT', undefined)
      await $.env.set('WORKTREE_PORT', undefined)
      await $.env.set('WORKTREE_NAME', undefined)
      envSig = ''
    }
    promptText = ''
    $.ui.status(undefined)
    return
  }
  const m = current.meta
  const sig = m.port + '|' + m.name
  if (sig !== envSig) {
    await $.env.set('PORT', String(m.port))
    await $.env.set('WORKTREE_PORT', String(m.port))
    await $.env.set('WORKTREE_NAME', m.name)
    envSig = sig
  }
  promptText = buildPrompt(current, trees)
  $.ui.status('⎇ ' + m.name + ' · ' + (current.branch || 'detached') + ' · :' + m.port + (m.task ? ' · ' + cleanSentence(m.task, 50) : ''))
}

async function refresh($, options) {
  if (refreshing) return
  refreshing = true
  try {
    const cwd = await $.session.cwd()
    await detectPlatform($, cwd)
    const list = await git($, ['worktree', 'list', '--porcelain', '-z'], { cwd })
    if (!list.ok) {
      repo = { error: list.isMissing ? 'git is not installed or not on PATH.' : 'Not inside a git repository.' }
      trees = []
      current = null
    } else {
      if (!gitVersion[0]) {
        const v = /(\d+)\.(\d+)/.exec((await git($, ['--version'])).out)
        gitVersion = v ? [Number(v[1]), Number(v[2])] : [2, 0]
      }
      const parsed = parseWorktrees(list.out)
      const main = parsed[0]
      repo = { mainRoot: main.path, name: baseName(main.isBare ? main.path.replace(/\.git$/, '') : main.path) || 'repo' }
      const cfg = await git($, ['config', '-z', '--get-regexp', '^' + SECTION + '\\.'], { cwd: main.path })
      const meta = parseMeta(cfg.out)
      trees = await Promise.all(parsed.map((t) => readTree($, t, meta)))
      const here = norm(cwd)
      current =
        trees
          .filter((t) => !t.isBare && (here === norm(t.path) || here.startsWith(norm(t.path) + '/')))
          .sort((a, b) => b.path.length - a.path.length)[0] ?? null
      await loadRegistry($)
      if (options?.isStart) await collectGarbage($)
      await ensureMeta($)
      if (paneOpen) await scanPorts($)
    }
    await applySession($)
    loaded = true
    const sig = JSON.stringify([repo, trees, current?.path, [...listening].sort()])
    if (sig !== lastSig) {
      lastSig = sig
      $.ui.invalidate('ui.render')
    }
  } finally {
    refreshing = false
  }
}

// ---------- actions ----------

function setNotice($, tone, text, path) {
  notice = { tone, text, ...(path ? { path } : {}) }
  $.ui.invalidate('ui.render')
}

function lastLines(text, n) {
  return String(text).trim().split('\n').filter(Boolean).slice(-n).join('\n')
}

async function runAction($, label, work) {
  if (busy) {
    $.ui.toast('worktrees is busy: ' + busy)
    return
  }
  busy = label
  $.ui.invalidate('ui.render')
  try {
    await work()
  } catch (err) {
    setNotice($, 'error', label + ' failed: ' + (err?.message ?? err))
  } finally {
    busy = ''
    lastSig = ''
    await refresh($).catch(() => {})
    $.ui.invalidate('ui.render')
  }
}

function findTree(path) {
  return trees.find((t) => norm(t.path) === norm(path)) ?? null
}

async function defaultBase($) {
  const head = await gitMain($, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const remote = head.ok ? head.out.trim() : ''
  if (remote) {
    const local = remote.replace(/^[^/]+\//, '')
    const has = await gitMain($, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + local])
    return has.ok ? local : remote
  }
  return trees[0]?.branch || 'HEAD'
}

async function branchFor($, task) {
  try {
    const r = await $.model.complete({
      model: MODEL,
      maxTokens: 30,
      timeoutMs: 20000,
      system:
        'Name a git branch for the task. Output only "<type>/<slug>": type one of feat, fix, chore, refactor, docs, test, perf, exp; ' +
        'slug 2-4 lowercase words joined by dashes. No quotes, nothing else.',
      prompt: task,
    })
    if (r.isAnswered) {
      const name = parseBranchName(r.text)
      if (name) return name
    }
  } catch {
    // fall back to the task's own words
  }
  return 'wt/' + (slugify(task) || 'task')
}

// git worktree add, then name, color, task and port block; copies ignored .env files
async function createTree($, task, base) {
  const text = cleanSentence(task, 120)
  if (!text) {
    setNotice($, 'info', 'Write the task in one sentence first.')
    return
  }
  let branch = await branchFor($, text)
  const slug = branch.slice(branch.indexOf('/') + 1)
  const home = parentDir(repo.mainRoot) + '/' + repo.name + '.worktrees'
  let path = home + '/' + slug
  for (let i = 2; (await $.fs.exists(path).catch(() => false)) || (await gitMain($, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])).ok; i++) {
    path = home + '/' + slug + '-' + i
    branch = branch.replace(/-\d+$/, '') + '-' + i
  }
  const from = base || (await defaultBase($))
  const args = ['worktree', 'add']
  // Git 2.48+: the worktree and the repository point at each other by relative
  // paths, so moving the parent folder or mounting it in a container keeps them linked
  if (gitVersion[0] > 2 || (gitVersion[0] === 2 && gitVersion[1] >= 48)) args.push('--relative-paths')
  let r = await gitMain($, [...args, '-b', branch, path, from], { timeoutMs: 120000 })
  // A branch named like the prefix ('feat') blocks 'feat/x': flatten the name
  if (!r.ok && /cannot lock ref|exists; cannot create/i.test(r.err)) {
    branch = branch.replace(/\//g, '-')
    r = await gitMain($, [...args, '-b', branch, path, from], { timeoutMs: 120000 })
  }
  if (!r.ok) {
    setNotice($, 'error', 'Could not create the worktree:\n' + lastLines(r.err || r.out, 6))
    return
  }
  const gd = await git($, ['rev-parse', '--absolute-git-dir'], { cwd: path })
  const id = gd.ok ? baseName(gd.out.trim()) : baseName(path)
  idCache.set(path, id)
  await setMeta($, id, 'name', slug)
  await setMeta($, id, 'task', text)
  const copied = await copyEnvFiles($, path)
  form = null
  setNotice(
    $,
    'ok',
    'Created "' + slug + '" on ' + branch + ' from ' + from + '.' + (copied.length ? '\nCopied ' + copied.join(', ') + ' from the main worktree.' : '') +
      '\nInstall its dependencies before starting a dev server.',
    path,
  )
}

async function copyEnvFiles($, dest) {
  const r = await gitMain($, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.env*'])
  const names = r.out.split('\0').filter((n) => n && !n.includes('/') && ENV_FILE.test(n))
  const copied = []
  for (const n of names) {
    try {
      const text = await $.fs.read(repo.mainRoot + '/' + n)
      await $.fs.write(dest + '/' + n, String(text))
      copied.push(n)
    } catch (err) {
      $.ui.log('worktrees-manager-mod: could not copy ' + n + ': ' + (err?.message ?? err), { to: 'debug' })
    }
  }
  return copied
}

// Moves this session into the worktree with Claude Code's own tool: the
// session's directory changes, nothing is checked out over another branch
async function switchTo($, tree) {
  if (current && norm(current.path) === norm(tree.path)) {
    setNotice($, 'info', 'This session already works in "' + tree.meta.name + '".')
    return
  }
  let r = await $.tool.call({ tool: 'EnterWorktree', path: nativePath(tree.path) }).catch((err) => ({ deny: String(err?.message ?? err) }))
  if ((r.deny || r.isError) && tree.isMain) {
    const back = await $.tool.call({ tool: 'ExitWorktree', action: 'keep' }).catch((err) => ({ deny: String(err?.message ?? err) }))
    if (!back.deny && !back.isError) r = back
  }
  if (r.deny || r.isError) {
    setNotice($, 'error', 'Could not switch to "' + tree.meta.name + '":\n' + lastLines(r.deny || r.text || 'refused', 4) + '\nUse Terminal to start a separate Claude session there.')
    return
  }
  setNotice($, 'ok', 'This session now works in "' + tree.meta.name + '" (' + (tree.branch || 'detached') + '). PORT=' + tree.meta.port + '.')
}

function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// A new terminal tab running Claude in the worktree; on Windows Terminal the
// tab takes the worktree's color
async function openTerminal($, tree) {
  const path = nativePath(tree.path)
  const title = tree.meta.name.replace(/[;"]/g, '')
  if (platform === 'windows') {
    const wt = await run($, ['wt', '-w', '0', 'nt', '-d', path, '--title', title, '--tabColor', tree.meta.color || '#888888', 'cmd', '/k', 'claude'])
    if (wt.ok) return setNotice($, 'ok', 'Opened a Windows Terminal tab in "' + tree.meta.name + '" running claude.')
    const start = await run($, ['cmd', '/d', '/c', 'start', title, '/D', path, 'cmd', '/k', 'claude'])
    if (start.ok) return setNotice($, 'ok', 'Opened a console window in "' + tree.meta.name + '" running claude.')
  } else if (platform === 'mac') {
    const script = 'tell application "Terminal" to do script "cd " & quoted form of "' + escapeAppleScript(path) + '" & " && claude"'
    const r = await run($, ['osascript', '-e', script, '-e', 'tell application "Terminal" to activate'])
    if (r.ok) return setNotice($, 'ok', 'Opened a Terminal window in "' + tree.meta.name + '" running claude.')
  }
  setNotice($, 'info', 'Could not open a terminal here. Run this in a new one:\ncd "' + path + '" && claude')
}

async function openEditor($, tree) {
  const path = nativePath(tree.path)
  const r = platform === 'windows' ? await run($, ['cmd', '/d', '/c', 'code', path]) : await run($, ['code', path])
  if (!r.ok) setNotice($, 'error', 'Could not start VS Code (`code`). Is it on PATH?\n' + lastLines(r.err, 2))
}

async function suggestTask($, tree, prompt) {
  const log = await git($, ['log', '--format=%s', '-n', '8'], { cwd: tree.path })
  const stat = await git($, ['diff', 'HEAD', '--stat'], { cwd: tree.path })
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 60,
    timeoutMs: 30000,
    system:
      'Describe what this git worktree is being used for in ONE short sentence (at most 14 words), imperative mood, ' +
      'as a task: e.g. "Add OAuth login to the settings page". Output only the sentence.',
    prompt:
      (prompt ? 'The developer asked:\n' + prompt.slice(0, 4000) + '\n\n' : '') +
      'Branch: ' + (tree.branch || 'detached') + '\nRecent commits:\n' + (log.out.trim() || '(none)') + '\n\nUncommitted changes:\n' + (stat.out.trim() || '(none)'),
  })
  const text = r.isAnswered ? cleanSentence(r.text, 120) : ''
  if (!text) throw new Error('the model gave no summary' + (r.reason ? ': ' + r.reason : ''))
  tree.meta.task = text
  await setMeta($, tree.id, 'task', text)
  return text
}

async function saveEdit($) {
  const f = form
  const tree = trees.find((t) => t.id === f.id)
  if (!tree) throw new Error('that worktree is gone')
  const name = f.name.replace(/[\r\n]+/g, ' ').trim() || tree.meta.name
  const port = Number(f.port)
  if (f.port && (!Number.isInteger(port) || port < 1024 || port + PORT_BLOCK - 1 > 65535)) {
    setNotice($, 'error', 'The port must be a whole number from 1024 to ' + (65535 - PORT_BLOCK + 1) + '.')
    return
  }
  if (port && port !== tree.meta.port) {
    const root = norm(repo.mainRoot)
    const owner =
      trees.find((t) => t !== tree && t.meta.port && Math.abs(t.meta.port - port) < PORT_BLOCK) ??
      registry.find((r) => !(r.root === root && r.id === tree.id) && Math.abs(r.port - port) < PORT_BLOCK)
    if (owner) {
      setNotice($, 'error', 'Ports ' + port + '-' + (port + PORT_BLOCK - 1) + ' overlap the block of "' + (owner.meta?.name ?? owner.name) + '".')
      return
    }
  }
  await setMeta($, tree.id, 'name', name)
  await setMeta($, tree.id, 'task', cleanSentence(f.task, 120))
  await setMeta($, tree.id, 'color', f.color)
  if (port && port !== tree.meta.port) {
    await releasePort($, tree.meta.port)
    await setMeta($, tree.id, 'port', String(port))
    tree.meta.name = name
    await claimPort($, tree, port)
  }
  form = null
  setNotice($, 'ok', 'Saved "' + name + '".')
}

async function removeTree($, tree, isForced) {
  confirm = ''
  const args = ['worktree', 'remove', ...(isForced ? ['--force'] : []), ...(isForced && tree.locked ? ['--force'] : []), tree.path]
  const r = await gitMain($, args, { timeoutMs: 60000 })
  if (!r.ok) {
    const isDirty = /modified or untracked|contains modified|is dirty|locked/i.test(r.err)
    if (isDirty && !isForced) confirm = 'force:' + tree.id
    setNotice($, 'error', 'Could not remove "' + tree.meta.name + '":\n' + lastLines(r.err || r.out, 4) + (isDirty && !isForced ? '\nPress Force remove to discard its changes.' : ''))
    return
  }
  await gitMain($, ['config', '--remove-section', SECTION + '.' + tree.id])
  await releasePort($, tree.meta.port)
  idCache.delete(tree.path)
  setNotice($, 'ok', 'Removed "' + tree.meta.name + '". Its branch ' + (tree.branch || '') + ' is kept; delete it with: git branch -d ' + (tree.branch || '<branch>'))
}

async function prune($) {
  const r = await gitMain($, ['worktree', 'prune', '-v'])
  if (!r.ok) return setNotice($, 'error', 'Prune failed:\n' + lastLines(r.err, 4))
  for (const t of trees.filter((x) => x.prunable)) {
    await gitMain($, ['config', '--remove-section', SECTION + '.' + t.id])
    await releasePort($, t.meta.port)
  }
  setNotice($, 'ok', 'Pruned the worktrees whose folders are gone.')
}

async function loadGuard($) {
  try {
    guardOn = (await $.store.get(STORE_GUARD)) !== false
  } catch {
    guardOn = true
  }
}

async function readScript($, cmd) {
  const name = scriptName(cmd)
  if (!name || !current) return undefined
  try {
    const pkg = JSON.parse(String(await $.fs.read(current.path + '/package.json')))
    const body = pkg?.scripts?.[name]
    return typeof body === 'string' ? body : undefined
  } catch {
    return undefined
  }
}

// ---------- drawing ----------

function shortPath(p) {
  const home = norm(parentDir(repo?.mainRoot ?? ''))
  const n = norm(p)
  return home && n.startsWith(home + '/') ? String(p).replace(/\\/g, '/').slice(home.length + 1) : p
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'worktrees', description: 'Open the worktrees panel (switch, create, ports, tasks)', immediate: true })
    } catch (err) {
      $.ui.log('worktrees-manager-mod: could not register /worktrees: ' + err.message, { to: 'debug' })
    }
    await loadGuard($)
    $.clock.every(POLL_MS, () => {
      if (paneOpen && !busy) refresh($).catch(() => {})
    })
    try {
      await refresh($, { isStart: true })
      // Open by itself when the repository has worktrees to tell apart; a pane
      // the mod opens waits for a wide enough terminal (144+ columns)
      if (repo && !repo.error && trees.length > 1) {
        paneOpen = true
        await $.ui.open({ id: PANE, title: 'Worktrees', columns: 60 })
      }
    } catch (err) {
      $.ui.log('worktrees-manager-mod: start failed: ' + (err?.message ?? err), { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async ($) => {
    paneOpen = true
    lastSig = ''
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Worktrees', focus: true, closeOnEscape: true, columns: 60 })
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: worktree bookkeeping never blocks Claude

  // The session's worktree, its task, the others and the ports, for the model
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!promptText) return composed
    return { ...composed, sections: [...composed.sections.filter((s) => s.id !== PROMPT_ID), { id: PROMPT_ID, text: promptText, scope: 'session' }] }
  })

  // A worktree without a task takes one from the first prompt sent in it
  on('prompt.submit', async ($, e, next) => {
    const tree = current
    const text = String(e.text ?? '')
    if (tree && !tree.isMain && !tree.meta.task && !summarised.has(tree.id) && e.origin?.kind !== 'plugin' && text.trim() && !text.trim().startsWith('/')) {
      summarised.add(tree.id)
      suggestTask($, tree, text)
        .then(() => applySession($))
        .then(() => $.ui.invalidate('ui.render'))
        .catch((err) => $.ui.log('worktrees-manager-mod: no task summary: ' + (err?.message ?? err), { to: 'debug' }))
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: worktree bookkeeping never blocks Claude

  // Port guard: a dev server on another worktree's port, or on a default port, is refused
  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    if (guardOn && current?.meta.port) {
      const cmd = String(e.command ?? '')
      const script = await readScript($, cmd)
      const others = [
        ...trees.filter((t) => t !== current && t.meta.port).map((t) => ({ name: t.meta.name, port: t.meta.port, path: t.path })),
        ...registry.filter((r) => r.root !== norm(repo.mainRoot)).map((r) => ({ name: r.name + ' in ' + r.repo, port: r.port, path: r.path })),
      ]
      const deny = checkDevCommand(cmd, { name: current.meta.name, port: current.meta.port }, others, script)
      if (deny) return { deny: deny + ' (If the user asked for that exact port, ask them to turn off the port guard in /worktrees.)' }
    }
    const result = await next(e)
    if (/\bworktree\b/.test(String(e.command ?? '')) && !busy) refresh($).catch(() => {})
    return result
  }).catch(($, e, next) => next(e)) // fail open: worktree bookkeeping never blocks Claude

  on('tool.call', { tool: SWITCH_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    lastSig = ''
    await refresh($).catch(() => {})
    return result
  }).catch(($, e, next) => next(e)) // fail open: worktree bookkeeping never blocks Claude

  on('classic.CwdChanged', async ($, e, next) => {
    refresh($).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e)) // fail open: worktree bookkeeping never blocks Claude

  on('turn.complete', async ($, e, next) => {
    if (!busy) refresh($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    paneOpen = true
    const { Box, Text, Button, Input, Select, Link } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? 60
    const narrow = cols < 46
    const redraw = () => $.ui.invalidate('ui.render')
    const rule = () => Text({ dimColor: true, children: ['─'.repeat(Math.max(10, Math.min(cols, 200)))] })

    if (!loaded) {
      refresh($).catch(() => {})
      return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['Reading worktrees…'] })] })
    }

    if (!repo || repo.error) {
      return Box({
        flexDirection: 'column',
        children: [
          Text({ color: 'yellow', children: [repo?.error ?? 'No repository.'] }),
          Text({ dimColor: true, wrap: 'wrap', children: ['Start Claude Code inside a git repository, then press r.'] }),
          Button({ key: 'refresh', label: 'Refresh (r)', hotkey: 'r', onPress: () => runAction($, 'Refreshing', async () => {}) }),
        ],
      })
    }

    const out = []
    const live = trees.filter((t) => t.meta.port && [...listening].some((p) => inBlock(p, t.meta.port))).length

    // --- header ---
    out.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ bold: true, children: ['⎇ ' + repo.name] }),
          Text({ dimColor: true, children: ['· ' + trees.length + ' worktree' + (trees.length === 1 ? '' : 's') + (live ? ' · ' + live + ' dev server' + (live === 1 ? '' : 's') + ' up' : '')] }),
        ],
      }),
    )
    if (current) {
      out.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ dimColor: true, children: ['this session:'] }),
            Text({ color: current.meta.color || 'cyan', bold: true, wrap: 'truncate-end', children: ['● ' + current.meta.name + (current.meta.port ? ' :' + current.meta.port : '')] }),
          ],
        }),
      )
    }

    // --- action bar ---
    const hasPrunable = trees.some((t) => t.prunable)
    out.push(
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 1,
        marginTop: 1,
        children: [
          Button({
            key: 'new',
            label: 'New worktree (n)',
            hotkey: 'n',
            ...(form ? {} : { variant: 'primary' }),
            onPress: () => {
              confirm = ''
              form = { mode: 'new', task: '', base: '' }
              redraw()
            },
          }),
          ...(hasPrunable ? [Button({ key: 'prune', label: 'Prune (p)', hotkey: 'p', onPress: () => runAction($, 'Pruning', () => prune($)) })] : []),
          Button({
            key: 'guard',
            label: 'Port guard: ' + (guardOn ? 'on' : 'off') + ' (g)',
            hotkey: 'g',
            plain: true,
            dimColor: !guardOn,
            onPress: () => {
              guardOn = !guardOn
              $.store.set(STORE_GUARD, guardOn).catch(() => {})
              $.ui.toast('Port guard ' + (guardOn ? 'on' : 'off'))
              redraw()
            },
          }),
          Button({ key: 'refresh', label: 'r', hotkey: 'r', plain: true, dimColor: true, onPress: () => runAction($, 'Refreshing', async () => {}) }),
        ],
      }),
    )

    if (busy) out.push(Text({ color: 'yellow', children: ['… ' + busy] }))

    // --- notice banner ---
    if (notice) {
      const color = notice.tone === 'ok' ? 'green' : notice.tone === 'error' ? 'red' : 'blue'
      const mark = notice.tone === 'ok' ? '✓ ' : notice.tone === 'error' ? '✕ ' : '● '
      const target = notice.path ? findTree(notice.path) : null
      out.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: color,
          paddingX: 1,
          marginTop: 1,
          children: [
            Text({ color, wrap: 'wrap', children: [mark + notice.text] }),
            Box({
              flexDirection: 'row',
              flexWrap: 'wrap',
              columnGap: 1,
              children: [
                ...(target
                  ? [
                      Button({ key: 'notice-switch', label: 'Switch session here', onPress: () => runAction($, 'Switching', () => switchTo($, target)) }),
                      Button({ key: 'notice-terminal', label: 'Open terminal', onPress: () => runAction($, 'Opening terminal', () => openTerminal($, target)) }),
                    ]
                  : []),
                Button({ key: 'dismiss', label: 'Dismiss', plain: true, dimColor: true, onPress: () => { notice = null; redraw() } }),
              ],
            }),
          ],
        }),
      )
    }

    // --- new worktree form ---
    if (form?.mode === 'new') {
      const f = form
      out.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          marginTop: 1,
          children: [
            Text({ color: 'cyan', bold: true, children: ['New worktree'] }),
            Text({ dimColor: true, wrap: 'wrap', children: ['One sentence: what will be done there. The branch, folder, color and ports follow from it.'] }),
            Input({
              key: 'new-task',
              label: 'Task ',
              value: f.task,
              placeholder: 'e.g. Add OAuth login to the settings page',
              submitLabel: 'create',
              autoFocus: true,
              onInput: (v) => { f.task = v },
              onSubmit: (v) => { f.task = v; return runAction($, 'Creating worktree', () => createTree($, v, f.base)) },
            }),
            ...(trees[0]?.branch
              ? [
                  Select({
                    key: 'new-base',
                    label: 'From ',
                    value: f.base || '',
                    options: [
                      { value: '', label: 'default branch' },
                      ...[...new Set(trees.map((t) => t.branch).filter(Boolean))].map((b) => ({ value: b, label: b })),
                    ],
                    onSelect: (v) => { f.base = v; redraw() },
                  }),
                ]
              : []),
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Button({ key: 'new-create', label: 'Create', variant: 'primary', onPress: () => runAction($, 'Creating worktree', () => createTree($, f.task, f.base)) }),
                Button({ key: 'new-cancel', label: 'Cancel', dimColor: true, onPress: () => { form = null; redraw() } }),
              ],
            }),
          ],
        }),
      )
    }

    // --- worktree cards ---
    out.push(rule())
    for (const t of trees) {
      const color = t.meta.color || 'gray'
      const isHere = current && t.path === current.path
      const ports = t.meta.port ? [...listening].filter((p) => inBlock(p, t.meta.port)).sort((a, b) => a - b) : []
      const isEditing = form?.mode === 'edit' && form.id === t.id
      const rows = []

      rows.push(
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          columnGap: 1,
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              flexShrink: 1,
              flexGrow: 1,
              children: [
                Text({ color, bold: true, children: ['●'] }),
                Text({ color, bold: true, wrap: 'truncate-end', children: [t.meta.name] }),
                ...(t.isMain ? [Text({ dimColor: true, children: ['main'] })] : []),
              ],
            }),
            isHere
              ? Text({ color, bold: true, children: ['◆ this session'] })
              : t.isBare || t.prunable
                ? Text({ children: [''] })
                : Button({ key: 'switch-' + t.id, label: 'Switch', onPress: () => runAction($, 'Switching', () => switchTo($, t)) }),
          ],
        }),
      )

      if (t.isBare) {
        rows.push(Text({ dimColor: true, children: ['bare repository'] }))
      } else if (t.prunable) {
        rows.push(Text({ color: 'red', wrap: 'wrap', children: ['✕ prunable: ' + t.prunable] }))
      } else {
        const s = t.status
        rows.push(
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 1,
            children: [
              Text({ color: 'cyan', wrap: 'truncate-middle', children: [t.isDetached ? 'detached ' + t.head.slice(0, 7) : t.branch] }),
              ...(s.upstream ? [Text({ color: s.ahead ? 'green' : undefined, dimColor: !s.ahead, children: ['↑' + s.ahead] }), Text({ color: s.behind ? 'red' : undefined, dimColor: !s.behind, children: ['↓' + s.behind] })] : []),
              Text({ color: s.changed ? 'yellow' : 'green', dimColor: !s.changed, children: [s.changed ? '~' + s.changed + ' changed' : '✓ clean'] }),
              ...(s.last && !narrow ? [Text({ dimColor: true, children: ['· ' + s.last] })] : []),
              ...(t.locked ? [Text({ color: 'magenta', children: ['locked'] })] : []),
            ],
          }),
        )
        rows.push(
          t.meta.task
            ? Text({ italic: true, wrap: 'wrap', children: [t.meta.task] })
            : Text({ dimColor: true, wrap: 'wrap', children: ['No task yet: Edit, or Suggest one from its commits.'] }),
        )
        if (t.meta.port) {
          rows.push(
            Box({
              flexDirection: 'row',
              flexWrap: 'wrap',
              columnGap: 1,
              children: [
                Text({ dimColor: true, children: ['ports ' + t.meta.port + '-' + (t.meta.port + PORT_BLOCK - 1)] }),
                // What listens on the worktree's ports, not whether its agent is working
                ...(ports.length
                  ? [
                      Text({ color: 'green', children: ['dev server'] }),
                      ...ports.map((p) => Link({ key: 'link-' + t.id + '-' + p, href: 'http://localhost:' + p, label: '● :' + p })),
                    ]
                  : [Text({ dimColor: true, children: ['○ no dev server'] })]),
              ],
            }),
          )
        }
        rows.push(Text({ dimColor: true, wrap: 'truncate-start', children: [shortPath(t.path)] }))
      }

      if (confirm === 'remove:' + t.id || confirm === 'force:' + t.id) {
        const isForce = confirm.startsWith('force:')
        rows.push(
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color: 'red', children: [isForce ? 'Discard its changes?' : 'Remove this worktree?'] }),
              Button({ key: 'confirm-remove-' + t.id, label: isForce ? 'Force remove' : 'Confirm remove', onPress: () => runAction($, 'Removing worktree', () => removeTree($, t, isForce)) }),
              Button({ key: 'keep-' + t.id, label: 'Keep', dimColor: true, onPress: () => { confirm = ''; redraw() } }),
            ],
          }),
        )
      } else if (!t.isBare && !t.prunable && !isEditing) {
        rows.push(
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 1,
            children: [
              Button({ key: 'terminal-' + t.id, label: 'Terminal', plain: true, onPress: () => runAction($, 'Opening terminal', () => openTerminal($, t)) }),
              Button({ key: 'editor-' + t.id, label: 'Editor', plain: true, onPress: () => runAction($, 'Opening editor', () => openEditor($, t)) }),
              Button({
                key: 'copy-' + t.id,
                label: 'Copy cd',
                plain: true,
                onPress: (p) => { $.ui.copy({ text: 'cd "' + nativePath(t.path) + '"', surface: p.surface }); $.ui.toast('Copied cd to ' + t.meta.name) },
              }),
              Button({
                key: 'edit-' + t.id,
                label: 'Edit',
                plain: true,
                onPress: () => {
                  confirm = ''
                  form = { mode: 'edit', id: t.id, name: t.meta.name, task: t.meta.task, color: t.meta.color || PALETTE[0].hex, port: t.meta.port ? String(t.meta.port) : '' }
                  redraw()
                },
              }),
              Button({ key: 'suggest-' + t.id, label: 'Suggest', plain: true, dimColor: true, onPress: () => runAction($, 'Summarising its task', () => suggestTask($, t)) }),
              ...(t.isMain || isHere
                ? []
                : [Button({ key: 'remove-' + t.id, label: 'Remove', plain: true, dimColor: true, onPress: () => { confirm = 'remove:' + t.id; redraw() } })]),
            ],
          }),
        )
      }

      if (isEditing) {
        const f = form
        rows.push(
          Box({
            flexDirection: 'column',
            marginTop: 1,
            children: [
              Input({ key: 'edit-name-' + t.id, label: 'Name  ', value: f.name, submitLabel: 'save', autoFocus: true, onInput: (v) => { f.name = v }, onSubmit: (v) => { f.name = v; redraw() } }),
              Input({ key: 'edit-task-' + t.id, label: 'Task  ', value: f.task, placeholder: 'One sentence', submitLabel: 'save', onInput: (v) => { f.task = v }, onSubmit: (v) => { f.task = v; redraw() } }),
              Input({ key: 'edit-port-' + t.id, label: 'Port  ', value: f.port, placeholder: 'first port of its block of ' + PORT_BLOCK, submitLabel: 'save', onInput: (v) => { f.port = v }, onSubmit: (v) => { f.port = v; redraw() } }),
              Select({
                key: 'edit-color-' + t.id,
                label: 'Color ',
                value: f.color,
                options: [...PALETTE.map((c) => ({ value: c.hex, label: c.name })), ...(PALETTE.some((c) => c.hex === f.color) ? [] : [{ value: f.color, label: f.color }])],
                onSelect: (v) => { f.color = v; redraw() },
              }),
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  Text({ color: f.color, bold: true, children: ['● preview'] }),
                  Button({ key: 'edit-save-' + t.id, label: 'Save', variant: 'primary', onPress: () => runAction($, 'Saving', () => saveEdit($)) }),
                  Button({ key: 'edit-cancel-' + t.id, label: 'Cancel', dimColor: true, onPress: () => { form = null; redraw() } }),
                ],
              }),
            ],
          }),
        )
      }

      out.push(
        Box({
          key: 'tree-' + t.id,
          flexDirection: 'column',
          borderStyle: isHere ? 'double' : 'round',
          borderColor: color,
          paddingX: 1,
          marginTop: 1,
          children: rows,
        }),
      )
    }

    if (!narrow) {
      out.push(rule())
      out.push(
        Text({
          dimColor: true,
          wrap: 'wrap',
          children: ['Each worktree owns ' + PORT_BLOCK + ' ports; Claude\'s shells get PORT for the session\'s worktree. Names, tasks and ports live in git config (wtmod.*).'],
        }),
      )
    }

    return Box({ flexDirection: 'column', children: out })
  })
}
