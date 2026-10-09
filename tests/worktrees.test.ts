import { expect, test, mock } from 'claude-code/testing'
import {
  parseWorktrees,
  parseMeta,
  parseListening,
  pickPortBlock,
  pickColor,
  findPorts,
  checkDevCommand,
  scriptName,
  parseBranchName,
  buildPrompt,
  norm,
  prettyModel,
  agentLabel,
  liveSessions,
  excludesWorktreeHome,
} from '../hooks/register.js'

const PANE = {
  plugin: 'worktrees-manager-mod',
  component: 'Pane',
  requestId: 'worktrees',
  viewport: { columns: 160, rows: 50 },
  props: { title: 'Worktrees', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const LIST = [
  'worktree C:/work/app', 'HEAD aaaaaaa1', 'branch refs/heads/main', '',
  'worktree C:/work/app.worktrees/auth', 'HEAD bbbbbbb2', 'branch refs/heads/feat/auth', '',
  'worktree C:/work/app.worktrees/gone', 'HEAD ccccccc3', 'detached', 'prunable gitdir file points to non-existent location', '',
].join('\0')

const META = [
  'wtmod.(main).port\n4100', 'wtmod.(main).color\n#4FC3F7',
  'wtmod.auth.name\nauth', 'wtmod.auth.task\nAdd OAuth login to settings', 'wtmod.auth.port\n4110', 'wtmod.auth.color\n#FFB74D', '',
].join('\0')

// A fake git (and netstat): answers by subcommand and records every argv
function fakeHost(calls: { argv: string[]; cwd?: string }[], overrides: Record<string, any> = {}) {
  return ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push({ argv, cwd: e.init?.cwd })
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv[0] === 'netstat') return ok(argv.includes('TCP') ? '  TCP    0.0.0.0:4110    0.0.0.0:0    LISTENING    1234\n' : '')
    if (argv[0] !== 'git') return ok('')
    const args = argv.slice(5)
    const sub = args[0]
    if (overrides[sub]) return overrides[sub](args, e)
    if (sub === '--version') return ok('git version 2.54.0.windows.1\n')
    if (sub === 'worktree' && args[1] === 'list') return ok(LIST)
    if (sub === 'config' && args.includes('--get-regexp')) return ok(META)
    if (sub === 'rev-parse' && args.includes('--git-common-dir')) return ok('C:/work/app/.git\n')
    if (sub === 'rev-parse' && args[1] === '--absolute-git-dir') return ok('C:/work/app/.git/worktrees/' + String(e.init?.cwd).split('/').pop() + '\n')
    if (sub === 'rev-parse' && args.includes('refs/heads/main')) return ok('aaaaaaa1\n')
    if (sub === 'rev-parse') return { value: { exitCode: 1, stdout: '', stderr: '' } }
    if (sub === 'status') return ok('# branch.oid 1\0# branch.head x\0# branch.upstream origin/x\0# branch.ab +2 -1\0' + '1 .M N... 100644 100644 100644 a b src/a.ts\0')
    if (sub === 'log') return ok('3 hours ago\n')
    if (sub === 'symbolic-ref') return ok('origin/main\n')
    return ok('')
  }
}

function stubs(on: any, calls: any[], opts: { cwd?: string | (() => string); overrides?: Record<string, any>; store?: Record<string, unknown> } = {}) {
  on('process.run', fakeHost(calls, opts.overrides))
  on('session.cwd', () => ({ value: typeof opts.cwd === 'function' ? opts.cwd() : opts.cwd ?? 'C:\\work\\app' }))
  mock.store(on, opts.store ?? {})
  mock.clock(on, { now: 1000000 })
  on('env.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
}

const gitArgs = (calls: any[]) => calls.filter((c) => c.argv[0] === 'git').map((c) => c.argv.slice(5).join(' '))

// ---------- pure helpers ----------

test('parses worktree list porcelain -z with prunable and detached entries', async () => {
  const list = parseWorktrees(LIST)
  expect(list.map((t: any) => t.branch)).toEqual(['main', 'feat/auth', ''])
  expect(list[0].isMain).toBe(true)
  expect(list[2].isDetached).toBe(true)
  expect(list[2].prunable).toMatch(/non-existent/)
})

test('parses wtmod config and listening ports on all three platforms', async () => {
  const meta = parseMeta(META)
  expect(meta['(main)']).toEqual({ port: 4100, color: '#4FC3F7' })
  expect(meta.auth.task).toBe('Add OAuth login to settings')
  expect([...parseListening('  TCP    [::]:5173    [::]:0    LISTENING    99')]).toEqual([5173])
  expect([...parseListening('node 123 me 23u IPv4 0x1 0t0 TCP *:4101 (LISTEN)')]).toEqual([4101])
  expect([...parseListening('LISTEN 0 511 127.0.0.1:4120 0.0.0.0:*')]).toEqual([4120])
})

test('port blocks skip used blocks and blocks with a listener', async () => {
  expect(pickPortBlock(new Set([4100]), new Set([4115]))).toBe(4120)
  expect(pickColor(['#4fc3f7'])).toBe('#FFB74D')
  expect(norm('C:\\Work\\App\\')).toBe('c:/work/app')
  expect(parseBranchName('"feat/oauth-login"')).toBe('feat/oauth-login')
})

test('finds explicit ports in shell commands', async () => {
  expect(findPorts('vite --port 4110 --strictPort')).toEqual([4110])
  expect(findPorts('$env:PORT=3000; npm run dev')).toEqual([3000])
  expect(findPorts('python -m http.server 8000')).toEqual([8000])
  expect(findPorts('next dev -p 4101')).toEqual([4101])
  expect(scriptName('pnpm dev')).toBe('dev')
  expect(scriptName('npm run dev -- --port 4100')).toBe('dev')
  expect(scriptName('npm install')).toBe('')
})

test('the port guard decision', async () => {
  const own = { name: 'main', port: 4100 }
  const others = [{ name: 'auth', port: 4110, path: 'C:/work/app.worktrees/auth' }]
  expect(checkDevCommand('vite --port 4100 --strictPort', own, others)).toBe(null)
  expect(checkDevCommand('npm run dev -- --port 4103', own, others)).toBe(null)
  expect(checkDevCommand('vite --port 4110', own, others)).toMatch(/belongs to the worktree "auth"/)
  expect(checkDevCommand('npx vite', own, others)).toMatch(/ignores the PORT variable/)
  expect(checkDevCommand('next dev', own, others)).toBe(null) // next reads PORT
  expect(checkDevCommand('npm run dev', own, others, 'vite')).toMatch(/ignores the PORT/)
  expect(checkDevCommand('npm run dev', own, others, 'next dev')).toBe(null)
  expect(checkDevCommand('npm run dev', own, others, 'vite --port 5173')).toMatch(/hard-codes port 5173/)
  expect(checkDevCommand('git status', own, others)).toBe(null)
  expect(checkDevCommand('curl localhost:4110/health', own, others)).toBe(null)
})

test('the prompt names the worktree, its task, the others and the ports', async () => {
  const trees = [
    { path: 'C:/work/app', branch: 'main', isMain: true, meta: { name: 'app', port: 4100, task: '' } },
    { path: 'C:/work/app.worktrees/auth', branch: 'feat/auth', meta: { name: 'auth', port: 4110, task: 'Add OAuth login' } },
  ]
  const text = buildPrompt(trees[1], trees)
  expect(text).toMatch(/worktree "auth" at C:\/work\/app.worktrees\/auth \(branch feat\/auth\)/)
  expect(text).toMatch(/Its task: Add OAuth login/)
  expect(text).toMatch(/"app" main at C:\/work\/app, ports 4100-4109/)
  expect(text).toMatch(/owns ports 4110-4119\. PORT=4110/)
})

// ---------- the panel ----------

for (const surface of ['terminal', 'desktop'] as const) {
  test('panel shows every worktree with color, task, ports and status on ' + surface, async ($, on) => {
    const calls: any[] = []
    stubs(on, calls)
    await $.command.run({ command: 'worktrees', args: '' })
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: 'auth' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Add OAuth login to settings' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ports 4110-4119' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◆ this session' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'switch-auth' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /prunable/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'prune' } as any)).toBeDefined()
    await ui.unmount()
  })
}

test('session start gives new worktrees a color and a port block, sets PORT and opens the panel', async ($, on) => {
  const calls: any[] = []
  const env: Record<string, string | undefined> = {}
  const opened: any[] = []
  on('process.run', fakeHost(calls, { config: (args: string[]) => ({ value: { exitCode: args.includes('--get-regexp') ? 1 : 0, stdout: '', stderr: '' } }) }))
  on('session.cwd', () => ({ value: 'C:\\work\\app.worktrees\\auth\\src' }))
  mock.store(on, {})
  mock.clock(on)
  on('env.set', ($: any, e: any) => { env[e.name] = e.value; return { value: undefined } })
  on('ui.open', ($: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: 'C:\\work\\app' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\app' } as any)
  const args = gitArgs(calls)
  expect(args).toContain('config wtmod.(main).port 4100')
  // 4110-4119 has a listener (netstat), so the second worktree skips that block
  expect(args).toContain('config wtmod.auth.port 4120')
  expect(args).toContain('config wtmod.auth.color #FFB74D')
  expect(env.PORT).toBe('4120')
  expect(env.WORKTREE_NAME).toBe('auth')
  expect(opened[0].id).toBe('worktrees')
  expect(opened[0].focus).toBeUndefined()
})

test('prompt.compose adds the worktree section', async ($, on) => {
  const calls: any[] = []
  stubs(on, calls, { cwd: 'C:\\work\\app.worktrees\\auth' })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await $.command.run({ command: 'worktrees', args: '' })
  const r: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
  const section = r.sections.find((s: any) => s.id === 'worktrees-manager-mod:worktree')
  expect(section.scope).toBe('session')
  expect(section.text).toMatch(/PORT=4110/)
})

// ---------- the port guard ----------

for (const tool of ['Bash', 'PowerShell']) {
  test(tool + ': a dev server on another worktree\'s port is refused, its own runs', async ($, on) => {
    const calls: any[] = []
    stubs(on, calls)
    on('tool.call', () => ({ result: 'ran' }))
    await $.command.run({ command: 'worktrees', args: '' })
    const bad: any = await $.tool.call({ tool, command: 'npx vite --port 4110' } as any)
    expect(bad.deny).toMatch(/belongs to the worktree "auth".*vite --port 4100 --strictPort/)
    const good: any = await $.tool.call({ tool, command: 'npx vite --port 4100 --strictPort' } as any)
    expect(good.deny).toBeUndefined()
  })
}

test('npm run dev is checked against the script it runs', async ($, on) => {
  const calls: any[] = []
  stubs(on, calls)
  on('fs.read', () => ({ value: JSON.stringify({ scripts: { dev: 'vite' } }) }))
  on('tool.call', () => ({ result: 'ran' }))
  await $.command.run({ command: 'worktrees', args: '' })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'npm run dev' } as any)
  expect(r.deny).toMatch(/ignores the PORT variable/)
})

test('the guard can be turned off from the panel', async ($, on) => {
  const calls: any[] = []
  stubs(on, calls)
  on('tool.call', () => ({ result: 'ran' }))
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'guard' })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'npx vite --port 4110' } as any)
  expect(r.deny).toBeUndefined()
})

// ---------- actions ----------

test('Switch moves the session with /cd, which leaves its shell unrestricted', async ($, on) => {
  const calls: any[] = []
  const tools: any[] = []
  let cwd = 'C:\\work\\app'
  stubs(on, calls, { cwd: () => cwd })
  on('command.list', () => ({ value: [{ name: 'cd' }, { name: 'clear' }] }))
  on('command.run', ($: any, e: any) => {
    if (e.command === 'cd') cwd = e.args
    return { text: '' }
  })
  on('tool.call', ($: any, e: any) => { tools.push(e); return { result: 'ok', text: 'Switched' } })
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'switch-auth' })
  expect(cwd).toBe('C:\\work\\app.worktrees\\auth')
  expect(tools.some((t) => t.tool === 'EnterWorktree')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /now works in "auth".*PORT=4110/ })).toBeDefined()
})

test('without /cd, Switch falls back to EnterWorktree', async ($, on) => {
  const calls: any[] = []
  const tools: any[] = []
  stubs(on, calls)
  on('command.list', () => ({ value: [{ name: 'clear' }] }))
  on('tool.call', ($: any, e: any) => { tools.push(e); return { result: 'ok', text: 'Switched' } })
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'switch-auth' })
  const enter = tools.find((t) => t.tool === 'EnterWorktree')
  expect(enter.path).toBe('C:\\work\\app.worktrees\\auth')
})

test('New worktree: model names the branch, git adds it under .claude/worktrees with relative paths, task is stored', async ($, on) => {
  const calls: any[] = []
  const written: Record<string, string> = {}
  stubs(on, calls)
  const slash = (p: string) => String(p).replace(/\\/g, '/')
  on('fs.read', ($: any, e: any) => (slash(e.path).endsWith('info/exclude') ? { value: '# git ls-files --others --exclude-from=.git/info/exclude\n' } : { deny: 'missing' }))
  on('fs.write', ($: any, e: any) => { written[slash(e.path)] = e.text; return { value: undefined } })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'feat/oauth-login', usage: USAGE } }))
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'new' })
  await ui.input({ key: 'new-task', text: 'Add OAuth login to the settings page' })
  const args = gitArgs(calls)
  expect(args).toContain('worktree add --relative-paths -b feat/oauth-login C:/work/app/.claude/worktrees/oauth-login main')
  expect(written['C:/work/app/.git/info/exclude']).toBe('# git ls-files --others --exclude-from=.git/info/exclude\n/.claude/worktrees/\n')
  expect(args).toContain('config wtmod.oauth-login.task Add OAuth login to the settings page')
  expect(await ui.find({ type: 'Text', text: /Created "oauth-login" on feat\/oauth-login from main/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'notice-switch' } as any)).toBeUndefined() // list stub has no new tree
})

test('Remove asks first, then removes the worktree, its config and its port', async ($, on) => {
  const calls: any[] = []
  stubs(on, calls, { store: { 'port:4110': { root: 'c:/work/app', id: 'auth', path: 'C:/work/app.worktrees/auth', name: 'auth', repo: 'app' } } })
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'remove-auth' })
  expect(gitArgs(calls).some((a) => a.startsWith('worktree remove'))).toBe(false)
  await ui.press({ key: 'confirm-remove-auth' })
  const args = gitArgs(calls)
  expect(args).toContain('worktree remove C:/work/app.worktrees/auth')
  expect(args).toContain('config --remove-section wtmod.auth')
})

test('a dirty worktree offers Force remove', async ($, on) => {
  const calls: any[] = []
  stubs(on, calls, {
    overrides: {
      worktree: (args: string[]) =>
        args[1] === 'remove'
          ? { value: { exitCode: 128, stdout: '', stderr: "fatal: '/x' contains modified or untracked files, use --force to delete it" } }
          : { value: { exitCode: 0, stdout: LIST, stderr: '' } },
    },
  })
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'remove-auth' })
  await ui.press({ key: 'confirm-remove-auth' })
  expect(await ui.find({ type: 'Button', key: 'confirm-remove-auth', label: 'Force remove' } as any)).toBeDefined()
})

test('outside a repository the panel says so', async ($, on) => {
  const calls: any[] = []
  stubs(on, calls, { overrides: { worktree: () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }) } })
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: 'Not inside a git repository.' })).toBeDefined()
})

test('if the session cwd is deleted, refresh falls back to known repo paths and keeps Switch actions', async ($, on) => {
  const calls: any[] = []
  let cwd = 'C:\\work\\app'
  stubs(on, calls, {
    cwd: () => cwd,
    overrides: {
      worktree: (args: string[], e: any) => {
        if (args[1] !== 'list') return { value: { exitCode: 0, stdout: LIST, stderr: '' } }
        return String(e.init?.cwd).includes('app.worktrees\\gone')
          ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }
          : { value: { exitCode: 0, stdout: LIST, stderr: '' } }
      },
    },
  })
  on('fs.exists', ($: any, e: any) => ({ value: String(e.path).includes('C:/work/app') }))
  await $.command.run({ command: 'worktrees', args: '' })
  cwd = 'C:\\work\\app.worktrees\\gone'
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'switch-auth' } as any)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Not inside a git repository.' })).toBeUndefined()
})

// ---------- what each worktree's session runs ----------

const ROOT = 'c:/work/app'
const presence = (over: Record<string, unknown>) => ({ sid: 'other1', root: ROOT, wt: 'auth', model: 'claude-opus-5-5', effort: 'high', agent: '', isWorking: true, at: 1000000, ...over })

test('exclude detection and the isolation advice in the prompt', async () => {
  expect(excludesWorktreeHome('*.log\n/.claude/worktrees/\n')).toBe(true)
  expect(excludesWorktreeHome('.claude/\n')).toBe(true)
  expect(excludesWorktreeHome('.claude/worktrees/**\r\n')).toBe(true)
  expect(excludesWorktreeHome('.claude/settings.local.json\n')).toBe(false)
  const tree = { path: 'C:/work/app/.claude/worktrees/x', branch: 'feat/x', meta: { name: 'x', port: 4110, task: '' } }
  expect(buildPrompt(tree, [tree], { isIsolated: true })).toMatch(/entered the worktree with EnterWorktree.*\n- One plain command per call/)
  expect(buildPrompt(tree, [tree])).not.toMatch(/EnterWorktree/)
})

test('model names, agent labels and live sessions', async () => {
  expect(prettyModel('claude-opus-5-5')).toBe('opus 5.5')
  expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('sonnet 5.5 1M')
  expect(prettyModel('claude-haiku-5-5-20260101')).toBe('haiku 5.5')
  expect(prettyModel('us.anthropic.claude-fable-5-1-v1:0')).toBe('fable 5.1')
  expect(agentLabel('claude')).toBe('')
  expect(agentLabel('Claude')).toBe('')
  expect(agentLabel('')).toBe('')
  expect(agentLabel('code-reviewer')).toBe('code-reviewer')
  const list = liveSessions(
    [presence({}), presence({ sid: 'old', at: 1 }), presence({ sid: 'elsewhere', root: 'c:/other' }), presence({ sid: 'me' })],
    ROOT,
    1000000,
    'me',
  )
  expect(list.map((s: any) => s.sid)).toEqual(['other1'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test('a card shows the model, effort and custom agent of the session working there on ' + surface, async ($, on) => {
    const calls: any[] = []
    stubs(on, calls, { store: { 'session:other1': presence({ agent: 'code-reviewer' }) } })
    await $.command.run({ command: 'worktrees', args: '' })
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: '◉ working' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'opus 5.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· high' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· agent code-reviewer' })).toBeDefined()
    await ui.unmount()
  })
}

test('the default claude agent and ended sessions show nothing', async ($, on) => {
  const calls: any[] = []
  stubs(on, calls, {
    store: {
      'session:other1': presence({ agent: 'claude', isWorking: false }),
      'session:gone': presence({ sid: 'gone', model: 'claude-haiku-5-5', at: 1 }),
    },
  })
  await $.command.run({ command: 'worktrees', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: '○ waiting' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'haiku 5.5' })).toBeUndefined()
})

test('a session publishes its worktree, model and agent, and working while a turn runs', async ($, on) => {
  const calls: any[] = []
  const saved = new Map<string, any>()
  on('process.run', fakeHost(calls))
  on('session.cwd', () => ({ value: 'C:\\work\\app.worktrees\\auth' }))
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => { saved.set(e.key, e.value); return { value: undefined } })
  on('store.keys', () => ({ value: [...saved.keys()] }))
  on('store.delete', ($: any, e: any) => { saved.delete(e.key); return { value: undefined } })
  mock.clock(on, { now: 5000 })
  on('session.id', () => ({ value: 'me1' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('settings.read', () => ({ value: { agent: 'code-reviewer', effortLevel: 'medium' } }))
  on('env.set', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: 'C:\\work\\app.worktrees\\auth' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work\\app.worktrees\\auth' } as any)
  expect(saved.get('session:me1')).toMatchObject({ sid: 'me1', root: ROOT, wt: 'auth', model: 'claude-sonnet-5-5', effort: 'medium', agent: 'code-reviewer', isWorking: false, at: 5000 })
  await $.turn.start({ text: 'hi', turnId: 't1' } as any)
  expect(saved.get('session:me1').isWorking).toBe(true)
  await $.session.end({ reason: 'other', sessionId: 'me1' } as any)
  expect(saved.has('session:me1')).toBe(false)
})
