import { expect, test } from 'claude-code/testing'

import { canvas, lineDiff, rest, SPRITES, toCells, wander } from './register'

const PANE = {
  plugin: 'session-work',
  component: 'Pane',
  requestId: 'session-work',
  props: {
    title: '세션 작업',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('lineDiff counts added and removed lines', async () => {
  expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: ['B', 'd'], removed: ['b'] })
  expect(lineDiff('', 'x\ny')).toEqual({ added: ['x', 'y'], removed: [] })
})

test('the pane lists a written file and a background command', async ($, on) => {
  const disk = new Map<string, string>([['C:/p/a.txt', 'one\ntwo']])
  on('command.register', () => ({ value: { command: 'session-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.read', (_, e) => {
    const text = disk.get(e.path.replaceAll('\\', '/'))
    return text === undefined ? { deny: 'missing' } : { value: text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    if (e.tool === 'Write') disk.set(e.file_path.replaceAll('\\', '/'), e.content)
    return { result: e.tool === 'Bash' ? { backgroundTaskId: 'b1' } : {} }
  })

  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: 'C:/p/a.txt', content: 'one\nTWO\nthree' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'dev 서버', run_in_background: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /바뀐 파일 1개/ }))?.text).toContain('+2 -1')
  expect((await ui.find({ type: 'Text', text: /dev 서버/ }))?.text).toContain('명령')
  await ui.unmount()
})

test('a long turn sends a toast, a short one or one with notifications off does not', async ($, on) => {
  const toasts: string[][] = []
  let stored: unknown
  on('command.register', () => ({ value: { command: 'session-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', () => ({ value: stored }))
  on('store.set', (_, e) => {
    stored = e.value
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    toasts.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: 'C:\\Users\\me\\proj', surface: 'terminal', isInteractive: true })
  const turn = { isAborted: false, reason: 'answer', turnId: 't' } as const
  await $.turn.complete({ ...turn, answer: '\n짧은 작업', durationMs: 5_000 })
  await $.turn.complete({ ...turn, answer: '\n빌드를 고쳤어요.\n자세히는…', durationMs: 192_000 })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Claude 작업 완료 · proj (3분 12초)')
  expect(toasts[0]).toContain('빌드를 고쳤어요.')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle-notify' })
  expect(stored).toBe(false)
  await $.turn.complete({ ...turn, answer: '긴 작업', durationMs: 300_000 })
  expect(toasts.length).toBe(1)
  await ui.unmount()
})

test('every buddy frame is 18x10 pixels and the pane draws the mood of the turn', async ($, on) => {
  for (const frame of Object.values(SPRITES).flat()) {
    expect(frame.length).toBe(10)
    for (const row of frame) expect(row.length).toBe(18)
  }
  on('command.register', () => ({ value: { command: 'session-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.session.start({ cwd: 'C:/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const cells = async () => (await ui.find({ type: 'Raster', key: 'buddy' }))?.props.cells
  // idle sits centred: (60 - 18) / 2
  expect(await cells()).toBe(toCells(canvas(SPRITES.idle[0], 21, 60)))
  await $.turn.start({ text: 'hi', turnId: 't' })
  expect(await cells()).toBe(toCells(canvas(SPRITES.right[0], 21, 60)))
  await ui.unmount()
})

test('the walking buddy leaves either edge and always comes back', async () => {
  let at = { x: 21, dir: 1 }
  let wentOff = false
  let cameBack = false
  for (let i = 0; i < 5000; i++) {
    at = wander(at.x, at.dir, 60)
    expect(at.x).toBeGreaterThanOrEqual(-18)
    expect(at.x).toBeLessThanOrEqual(60)
    if (at.x >= 60 || at.x <= -18) wentOff = true
    else if (wentOff) cameBack = true
  }
  expect(cameBack).toBe(true)
  expect(canvas(['abc'], -1, 4)).toEqual(['bc..'])
})

test('resting, the buddy walks back in a cell at a time and strolls only on screen', async () => {
  let at = { x: -18, dir: -1, stroll: 0, isWalking: false }
  for (let i = 0; i < 5000; i++) {
    const next = rest(at, 60, true)
    expect(Math.abs(next.x - at.x)).toBeLessThanOrEqual(1)
    if (i >= 18) {
      expect(next.x).toBeGreaterThanOrEqual(0)
      expect(next.x).toBeLessThanOrEqual(42)
    }
    at = next
  }
  // a failed face comes back in but never strolls
  const failed = rest({ x: 10, dir: 1, stroll: 5, isWalking: false }, 60, false, () => 0)
  expect(failed).toEqual({ x: 10, dir: 1, stroll: 0, isWalking: false })
})
