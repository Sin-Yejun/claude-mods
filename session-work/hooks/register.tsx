import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, FileChange, Job, Mood } from '../types'

const PANE = 'session-work'
const TITLE = '세션 작업'
const cwd = atom({ plugin: 'session-work', key: 'cwd' } as const, '')
const files = atom({ plugin: 'session-work', key: 'files' } as const, [] as FileChange[])
const jobs = atom({ plugin: 'session-work', key: 'jobs' } as const, [] as Job[])
const agents = atom({ plugin: 'session-work', key: 'agents' } as const, [] as AgentRow[])
const openPath = atom({ plugin: 'session-work', key: 'openPath' } as const, '')
const notifyOn = atom({ plugin: 'session-work', key: 'notifyOn' } as const, true)
const mood = atom({ plugin: 'session-work', key: 'mood' } as const, 'idle' as Mood)

// The buddy: 18x10 pixels on a 12-pixel-tall canvas (room to jump), two pixels a cell via
// half blocks. O body, E eye, W zzz / '!'.
const BUDDY_COLUMNS = 18
const BUDDY_ROWS = 6
export const BUDDY_Y = 2
const PIXEL: Record<string, number> = { O: 0xd97757, E: 0x1f1f1f, W: 0xeeeeee }
const NO_COLOR = 0x01000000
// walking speed; the idle and failed faces change every IDLE_EVERY frames
const FRAME_MS = 150
const IDLE_EVERY = 4

const body = (eyes: string, lids: string, legs: string, armsUp = false) => [
  '..............', '..OOOOOOOOOO..', eyes, armsUp ? 'OO' + lids.slice(2, 12) + 'OO' : lids,
  'OOOOOOOOOOOOOO', armsUp ? '..OOOOOOOOOO..' : 'OOOOOOOOOOOOOO', '..OOOOOOOOOO..', '..OOOOOOOOOO..', legs, legs,
]
const side = (...rows: string[]) => Array.from({ length: 10 }, (_, i) => rows[i] ?? '....')
const sprite = (left: string[], right: string[]) => left.map((row, i) => row + right[i])

const LEGS_A = '...O.O..O.O...'
const LEGS_B = '..O.O....O.O..'
const LOOK_LEFT = '..OEOOOOEOOO..'
const LOOK_RIGHT = '..OOOEOOOOEO..'
const OPEN = '..OOEOOOOEOO..'
const NO_EYES = '..OOOOOOOOOO..'
const SHUT = '..OEEOOOOEEO..'

const walk = (eyes: string) => [LEGS_A, LEGS_B].map(legs => sprite(body(eyes, eyes, legs), side())) as [string[], string[]]
const arms = () => [false, true].map(up => sprite(body(OPEN, OPEN, LEGS_A, up), side())) as [string[], string[]]

export const SPRITES: Record<'left' | 'right' | 'idle' | 'failed' | 'type' | 'cheer', [string[], ...string[][]]> = {
  left: walk(LOOK_LEFT),
  right: walk(LOOK_RIGHT),
  idle: [
    sprite(body(NO_EYES, SHUT, LEGS_A), side('....', '....', '.WWW', '..W.', '.WWW')),
    sprite(body(NO_EYES, SHUT, LEGS_A), side('WWW.', '.W..', 'WWW.')),
  ],
  failed: [sprite(body(SHUT, SHUT, LEGS_A), side('..W.', '..W.', '..W.', '....', '..W.'))],
  // arms down, arms up: hammering at a file, or in the air on a jump
  type: arms(),
  cheer: arms(),
}

// A subagent's little companion, 6x6, hopping on alternate legs.
export const HELPER: [string[], string[]] = [
  ['......', '.OOOO.', '.EOOE.', 'OOOOOO', '.OOOO.', '.O..O.'],
  ['......', '.OOOO.', '.EOOE.', 'OOOOOO', '.OOOO.', 'O....O'],
]
const MAX_HELPERS = 3
const HELPER_GAP = 7

// Each cell is the upper pixel as '▀' foreground over the lower as background.
export const toCells = (pixels: string[]) => {
  const words: number[] = []
  for (let y = 0; y < pixels.length; y += 2) {
    const upper = pixels[y] ?? ''
    const lower = pixels[y + 1] ?? ''
    for (let x = 0; x < upper.length; x++) {
      const top = PIXEL[upper.charAt(x)]
      const bottom = PIXEL[lower.charAt(x)]
      if (top !== undefined) words.push(0x2580, top, bottom ?? NO_COLOR)
      else if (bottom !== undefined) words.push(0x2584, bottom, NO_COLOR)
      else words.push(0x20, NO_COLOR, NO_COLOR)
    }
  }

  // the runtime has Uint8Array.toBase64; the es2023 lib does not type it yet
  const bytes = new Uint8Array(Uint32Array.from(words).buffer) as Uint8Array & { toBase64: () => string }

  return bytes.toBase64()
}

export type Layer = { pixels: string[]; x: number; y: number }

// The layers painted in order on a width x height canvas; '.' is see-through, anything off the edges is cut.
export const compose = (layers: Layer[], width: number, height: number) => {
  const rows = Array.from({ length: height }, () => Array<string>(width).fill('.'))
  for (const { pixels, x, y } of layers)
    pixels.forEach((row, r) => {
      const line = rows[y + r]
      for (let c = 0; line && c < row.length; c++) {
        const pixel = row[c]
        if (pixel && pixel !== '.' && x + c >= 0 && x + c < width) line[x + c] = pixel
      }
    })

  return rows.map(row => row.join(''))
}

// One busy step: mostly straight, now and then a turn; fully off an edge, it turns back or comes round the other side.
export const wander = (x: number, dir: number, width: number, random = Math.random) => {
  let next = x + dir
  let nextDir = random() < 0.04 ? -dir : dir
  const offRight = next >= width
  if (offRight || next <= -BUDDY_COLUMNS) {
    if (random() < 0.5) nextDir = offRight ? -1 : 1
    else next = offRight ? 1 - BUDDY_COLUMNS : width - 1
  }

  return { x: next, dir: nextDir }
}

export type Rest = { x: number; dir: number; stroll: number; isWalking: boolean }

// One resting step, a cell at most: off screen it walks back in; otherwise it sleeps,
// now and then getting up for a stroll that stays on screen. A failed face never strolls.
export const rest = (at: Rest, width: number, mayStroll: boolean, random = Math.random): Rest => {
  const maxX = Math.max(0, width - BUDDY_COLUMNS)
  if (at.x < 0 || at.x > maxX) {
    const dir = at.x < 0 ? 1 : -1
    return { x: at.x + dir, dir, stroll: 0, isWalking: true }
  }
  if (at.stroll > 0 && mayStroll && maxX > 0) {
    let dir = random() < 0.1 ? -at.dir : at.dir
    if (at.x + dir < 0 || at.x + dir > maxX) dir = -dir
    return { x: at.x + dir, dir, stroll: at.stroll - 1, isWalking: true }
  }
  // about one stroll every 30 seconds of rest
  const stroll = mayStroll && random() < 0.01 ? 10 + Math.floor(random() * 30) : 0

  return { ...at, stroll, isWalking: false }
}

export type Action = { kind: 'type' | 'jump'; tick: number }
const ACTION_TICKS: Record<Action['kind'], number> = { type: 10, jump: 12 }
const JUMP_ARC = [0, -1, -2, -2, -1, 0]

export type Scene = { mood: Mood; buddy: Rest; action?: Action; helpers: number; tick: number }

const pick = <T,>(frames: [T, ...T[]], i: number) => frames[i % frames.length] ?? frames[0]

// What to paint this frame: an action (hammering, a jump) holds the buddy still; else it walks or rests.
// The helpers trail behind it, one per running subagent.
export const scene = ({ mood: m, buddy: b, action: a, helpers, tick }: Scene): Layer[] => {
  let pixels = pick(SPRITES[m === 'failed' ? 'failed' : 'idle'], Math.floor(tick / IDLE_EVERY))
  let y = BUDDY_Y
  if (a?.kind === 'type') pixels = pick(SPRITES.type, a.tick)
  else if (a?.kind === 'jump') {
    const lift = JUMP_ARC[a.tick % JUMP_ARC.length] ?? 0
    y += lift
    pixels = pick(SPRITES.cheer, lift < 0 ? 1 : 0)
  } else if (m === 'working' || b.isWalking) pixels = pick(SPRITES[b.dir > 0 ? 'right' : 'left'], tick)

  const trail = Array.from({ length: Math.min(helpers, MAX_HELPERS) }, (_, i) => ({
    pixels: pick(HELPER, tick + i),
    x: b.dir > 0 ? b.x - HELPER_GAP * (i + 1) : b.x + 15 + HELPER_GAP * i,
    y: BUDDY_ROWS * 2 - 6,
  }))

  return [...trail, { pixels, x: b.x, y }]
}

let frameTimer: { cancel: () => void } | undefined
let frameTick = 0
let paneColumns = 40
let lastBlit = ''
// shortcut: these live in the module, so a reload re-centres the buddy and drops its helpers until the next agent change.
let buddy: Rest | undefined
let action: Action | undefined
let helpers = 0

const centred = (): Rest => ({ x: Math.max(0, Math.floor((paneColumns - BUDDY_COLUMNS) / 2)), dir: 1, stroll: 0, isWalking: false })

const buddyCells = (m: Mood) =>
  toCells(compose(scene({ mood: m, buddy: (buddy ??= centred()), action, helpers, tick: frameTick }), paneColumns, BUDDY_ROWS * 2))

// One frame on: an action plays out first; else work wanders, rest moves at half pace.
const step = (m: Mood) => {
  const b = (buddy ??= centred())
  frameTick++
  if (action) action = action.tick + 1 < ACTION_TICKS[action.kind] ? { ...action, tick: action.tick + 1 } : undefined
  else if (m === 'working') buddy = { ...wander(b.x, b.dir, paneColumns), stroll: 0, isWalking: true }
  else if (frameTick % 2 === 0) buddy = rest(b, paneColumns, m === 'idle')
}

// a turn shorter than this gets no notification
const NOTIFY_AFTER_MS = 2 * 60_000

const DIFF_LINES = 12

// shortcut: multiset line diff, a moved line counts as unchanged; use a real LCS diff if that misleads.
export function lineDiff(before: string, after: string) {
  const left = new Map<string, number>()
  for (const line of before === '' ? [] : before.split('\n'))
    left.set(line, (left.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after === '' ? [] : after.split('\n')) {
    const n = left.get(line) ?? 0
    if (n > 0) left.set(line, n - 1)
    else added.push(line)
  }
  const removed = [...left].flatMap(([line, n]) => Array<string>(n).fill(line))

  return { added, removed }
}

const readOr = (path: string, $: EngineInterface) => $.fs.read(path).catch(() => '')

const relative = (path: string, base: string) => {
  const p = path.replaceAll('\\', '/')
  const b = base.replaceAll('\\', '/').replace(/\/$/, '')

  return b && p.toLowerCase().startsWith(b.toLowerCase() + '/') ? p.slice(b.length + 1) : p
}

const refreshAgents = async ($: EngineInterface) => {
  const list = await $.agent.list()
  helpers = list.filter(a => ['running', 'pending', 'waiting'].includes(a.status)).length
  await update($, agents, () =>
    list.map(a => ({ id: a.id, label: a.description || a.type, status: a.status })),
  )
}

// Diffs the file as it was before the call against after, and adds it to the list.
const trackFile = async <R extends { deny?: string; isError?: true }>(
  $: EngineInterface,
  filePath: string,
  run: () => Promise<R>,
): Promise<R> => {
  const before = await readOr(filePath, $)
  const ran = await run()
  if (ran.deny !== undefined || ran.isError) return ran

  const { added, removed } = lineDiff(before, await readOr(filePath, $))
  const path = relative(filePath, await read($, cwd))
  const lastDiff = [...removed.map(l => `- ${l}`), ...added.map(l => `+ ${l}`)].slice(0, DIFF_LINES)
  // shortcut: totals add up per edit, so an edit later undone still counts; diff against the first-seen content if that matters.
  await update($, files, list => {
    const old = list.find(f => f.path === path)
    const change: FileChange = {
      path,
      added: (old?.added ?? 0) + added.length,
      removed: (old?.removed ?? 0) + removed.length,
      edits: (old?.edits ?? 0) + 1,
      lastDiff,
    }

    return [change, ...list.filter(f => f.path !== path)]
  })
  if (action?.kind !== 'jump') action = { kind: 'type', tick: 0 }

  return ran
}

export const formatDuration = (ms: number) => {
  const sec = Math.round(ms / 1000)
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`
}

const isWindowsPath = (path: string) => /^[A-Za-z]:/.test(path)

// The terminal's own notification never showed on this Windows setup, so Windows gets a native toast.
const sendNotice = async ($: EngineInterface, base: string, title: string, message: string) => {
  if (!isWindowsPath(base)) {
    await $.ui.notify(message, { title })
    return
  }
  const script = `${$.plugin.root}/assets/toast.ps1`
  const argv = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title, '-Message', message]
  const ran = await $.process.run(argv)
  if (ran.exitCode !== 0) await $.ui.notify(message, { title })
}

const ICON: Record<string, string> = {
  running: '●', pending: '○', waiting: '◐', idle: '◌', scheduled: '⏱',
  completed: '✓', failed: '✗', killed: '■',
}
const COLOR: Record<string, string> = { running: 'yellow', completed: 'green', failed: 'red' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, cwd, () => e.cwd)
    // the ON/OFF choice outlives the session; absent means ON
    const saved = await $.store.get('notifyOn')
    await update($, notifyOn, () => saved !== false)
    await $.command.register({ name: 'session-work', description: '세션 작업 패널 열기' })
    void $.ui.open({ id: PANE, title: TITLE })

    // a closed pane just answers { deny } to each blit
    frameTimer?.cancel()
    frameTimer = $.clock.every(FRAME_MS, async () => {
      const m = await read($, mood)
      step(m)
      const cells = buddyCells(m)
      if (cells === lastBlit) return
      lastBlit = cells
      await $.ui.blit({ requestId: PANE, key: 'buddy', cells, columns: paneColumns, rows: BUDDY_ROWS })
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await update($, mood, () => 'working')

    return next(e)
  })

  on('command.run', { command: 'session-work' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: '세션 작업 패널을 열었어요.' }
  })

  on('tool.call', { tool: 'Edit' }, ($, e, next) => trackFile($, e.file_path, () => next(e)))
    .catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, ($, e, next) => trackFile($, e.file_path, () => next(e)))
    .catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && !ran.isError ? ran.result.backgroundTaskId : undefined
    if (id) {
      const job: Job = { id, kind: 'shell', label: e.description ?? e.command, status: 'running' }
      await update($, jobs, list => [job, ...list])
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const { id, humanSchedule, recurring } = ran.result
      // shortcut: a one-shot job stays 'scheduled' after it fires; no event names which job fired.
      const label = `${humanSchedule}${recurring ? '' : ' (1회)'} · ${e.prompt}`
      const job: Job = { id, kind: 'cron', label, status: 'scheduled' }
      await update($, jobs, list => [job, ...list])
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError)
      await update($, jobs, list => list.filter(j => j.id !== e.id))

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const id = ran.result.task_id
      await update($, jobs, list => list.map(j => (j.id === id ? { ...j, status: 'killed' } : j)))
      await refreshAgents($)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    await refreshAgents($)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refreshAgents($)
    // a failure stays on its face until the next turn starts
    if (!e.agentId) {
      const now = await update($, mood, m => (m === 'failed' ? m : 'idle'))
      if (now === 'idle' && !e.isAborted) action = { kind: 'jump', tick: 0 }
    }

    // the main loop only: a subagent's turn ends inside the main one
    if (!e.agentId && !e.isAborted && e.durationMs >= NOTIFY_AFTER_MS && (await read($, notifyOn))) {
      const base = await read($, cwd)
      const folder = base.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? ''
      const firstLine = e.answer.split('\n').find(l => l.trim())?.trim() ?? ''
      const message = firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine || '작업이 끝났어요.'
      await sendNotice($, base, `Claude 작업 완료 · ${folder} (${formatDuration(e.durationMs)})`, message)
    }

    return done
  })

  // A background task's end arrives as a <task-notification> row.
  // shortcut: parses the notification's text tags; switch to a typed field if the engine exposes one at this event.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const text = JSON.stringify(e.message.content ?? '')
    if (text.includes('<task-notification>')) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]
      const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]
      if (id && status)
        await update($, jobs, list => list.map(j => (j.id === id ? { ...j, status } : j)))
      if (status === 'failed') await update($, mood, () => 'failed')
      await refreshAgents($)
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Raster is terminal-only
    const Raster = 'Raster' in elements ? elements.Raster : undefined
    paneColumns = e.props.bodyColumns ?? 40
    const buddyFrame = buddyCells(await read($, mood))
    const docked = e.props.placement === 'dock'
    const buddyTop = e.props.scroll.offset + e.props.scroll.bodyRows - BUDDY_ROWS
    const fileList = await read($, files)
    const jobList = await read($, jobs)
    const agentList = await read($, agents)
    const opened = await read($, openPath)
    const isNotifyOn = await read($, notifyOn)
    const totalAdded = fileList.reduce((n, f) => n + f.added, 0)
    const totalRemoved = fileList.reduce((n, f) => n + f.removed, 0)
    const rows = [
      ...agentList.map(a => ({ key: `a:${a.id}`, kind: '에이전트', label: a.label, status: a.status })),
      ...jobList.map(j => ({ key: `j:${j.id}`, kind: j.kind === 'shell' ? '명령' : '예약', label: j.label, status: j.status })),
    ]
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 14)
    const clip = (s: string) => (s.length > width ? s.slice(0, width - 1) + '…' : s)

    const base = await read($, cwd)
    // `code` is code.cmd on Windows, which needs a shell to start
    const openInCode = async () => {
      const argv = base.includes('\\') || /^[A-Za-z]:/.test(base) ? ['cmd', '/c', 'code', base] : ['code', base]
      const ran = await $.process.run(argv).catch((err: unknown) => ({ exitCode: 1, stderr: String(err) }))
      if (ran.exitCode !== 0) $.ui.toast(`VS Code를 열지 못했어요: ${ran.stderr.trim().slice(0, 80)}`)
    }

    return (
      <Box flexDirection="column" minHeight={docked ? e.props.scroll.bodyRows : undefined}>
        <Box flexDirection="row" gap={2}>
          <Button key="open-in-code" variant="primary" onPress={openInCode}>VS Code로 열기</Button>
          <Button
            key="toggle-notify"
            dimColor={!isNotifyOn}
            onPress={async () => {
              const value = await update($, notifyOn, wasOn => !wasOn)
              await $.store.set('notifyOn', value)
            }}
          >
            {isNotifyOn ? '알림 ON' : '알림 OFF'}
          </Button>
        </Box>
        <Text> </Text>
        <Box flexDirection="row" gap={2}>
          <Text bold>
            바뀐 파일 {fileList.length}개{' '}
            <Text color="green">+{totalAdded}</Text> <Text color="red">-{totalRemoved}</Text>
          </Text>
          {fileList.length > 0 && (
            <Button
              key="reset-files"
              dimColor
              onPress={async () => {
                await update($, files, () => [])
                await update($, openPath, () => '')
              }}
            >
              초기화
            </Button>
          )}
        </Box>
        {fileList.length === 0 && <Text dimColor>  아직 없음</Text>}
        {fileList.map(f => (
          <Box flexDirection="column">
            <Button
              key={`f:${f.path}`}
              plain
              onPress={() => update($, openPath, p => (p === f.path ? '' : f.path))}
            >
              {opened === f.path ? '▾ ' : '▸ '}
              {clip(f.path)} <Text color="green">+{f.added}</Text>{' '}
              <Text color="red">-{f.removed}</Text>
            </Button>
            {opened === f.path &&
              f.lastDiff.map(line => (
                <Text color={line.startsWith('+') ? 'green' : 'red'}>    {clip(line)}</Text>
              ))}
          </Box>
        ))}
        <Text> </Text>
        <Text bold>작업 {rows.filter(r => ['running', 'pending', 'waiting', 'scheduled'].includes(r.status)).length}개 진행 중</Text>
        {rows.length === 0 && <Text dimColor>  아직 없음</Text>}
        {rows.map(r => (
          <Text dimColor={['completed', 'killed'].includes(r.status)}>
            <Text color={COLOR[r.status]}>{ICON[r.status] ?? '·'}</Text> {r.kind} {clip(r.label)}
          </Text>
        ))}
        {Raster && docked && <Box height={BUDDY_ROWS + 1} />}
        {Raster && !docked && <Text> </Text>}
        {Raster && (
          // docked, it floats over the window's last rows, wherever the list is scrolled
          <Box position={docked ? 'absolute' : 'relative'} top={docked ? buddyTop : undefined} left={0}>
            <Raster key="buddy" columns={paneColumns} rows={BUDDY_ROWS} cells={buddyFrame} />
          </Box>
        )}
      </Box>
    )
  })
}
