/**
 * Live configuration plumbing: the profile entry's Config is the plugin's
 * whole settings section, a write travels the harness settings service into
 * the profile patch document, and the cross-field rules a schema cannot
 * express are enforced on every write path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BRANCH, DEFAULT_CLEANUP_KEEP_COMMITS, DEFAULT_CLEANUP_PERIOD_HOURS } from '../src/settings.ts'
import { composeSessionSync } from './compose.ts'
import { fakePersistence } from './persistence-double.ts'

const execFileAsync = promisify(execFile)

let previousDshHome: string | undefined

afterEach(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
})

/** A project directory plus a bare git remote a configured plugin can drive. */
async function bench(): Promise<{ remote: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-live-'))
  const remote = join(root, 'remote.git')
  await execFileAsync('git', ['init', '--bare', '-b', 'main', remote])
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  return { remote, project }
}

/** The section a freshly composed plugin resolves. */
const DEFAULT_SECTION = {
  enabled: false,
  remote: '',
  branch: DEFAULT_BRANCH,
  intervalMinutes: 5,
  mappings: [],
  cleanup: { enabled: false, periodHours: DEFAULT_CLEANUP_PERIOD_HOURS, keepCommits: DEFAULT_CLEANUP_KEEP_COMMITS },
}

describe('session-sync live configuration', () => {
  it('resolves the section from the row Config and suppresses the generated settings page', async () => {
    previousDshHome = process.env.DSH_HOME
    const composed = await composeSessionSync({ startupSyncDelayMs: 60_000, persistence: fakePersistence() })
    expect(composed.service.getSettings()).toEqual(DEFAULT_SECTION)
    expect(composed.service.settingsWritable).toBe(true)
    const descriptor = composed.ctx.settings.describe().find(candidate => String(candidate.ns) === 'session-sync')
    expect(descriptor?.autoGenerate).toBe(false)
  })

  it('persists a settings write into the profile patch and reaches the live config without remounting', async () => {
    previousDshHome = process.env.DSH_HOME
    const composed = await composeSessionSync({ startupSyncDelayMs: 60_000, persistence: fakePersistence() })
    const service = composed.service

    await composed.write({
      enabled: true,
      remote: 'git@example.com:team/repo.git',
      mappings: [{ key: 'demo', path: '/work/demo' }],
    })

    // A volatile commit, not an ordinary reload: the running instance stays.
    expect(composed.service).toBe(service)
    expect(service.getSettings()).toMatchObject({
      enabled: true,
      remote: 'git@example.com:team/repo.git',
      mappings: [{ key: 'demo', path: '/work/demo' }],
    })
    expect(service.status().configured).toBe(true)
    expect(composed.patchDocument()).toContain('git@example.com:team/repo.git')
  })

  it('refuses a write the cross-field rules reject and leaves the document untouched', async () => {
    previousDshHome = process.env.DSH_HOME
    const composed = await composeSessionSync({
      startupSyncDelayMs: 60_000,
      persistence: fakePersistence(),
      config: { enabled: true, remote: 'git@example.com:team/repo.git' },
    })
    const document = composed.patchDocument()

    await expect(composed.write({ remote: '' })).rejects.toThrow(/remote is required when the plugin is enabled/)
    expect(composed.service.getSettings().remote).toBe('git@example.com:team/repo.git')
    expect(composed.patchDocument()).toBe(document)
  })

  it('refuses a schema-invalid write with the schema message', async () => {
    previousDshHome = process.env.DSH_HOME
    const composed = await composeSessionSync({ startupSyncDelayMs: 60_000, persistence: fakePersistence() })
    await expect(composed.write({ intervalMinutes: 0 })).rejects.toThrow(/intervalMinutes/)
    await expect(composed.write({ mappings: 'not-an-array' })).rejects.toThrow(/mappings/)
    expect(composed.service.getSettings()).toEqual(DEFAULT_SECTION)
  })

  it('serves the settings view over the service face the HTTP routes call', async () => {
    previousDshHome = process.env.DSH_HOME
    const composed = await composeSessionSync({ startupSyncDelayMs: 60_000, persistence: fakePersistence() })

    await composed.service.updateSettings({ branch: 'trunk' })
    expect(composed.service.getSettings().branch).toBe('trunk')

    await expect(composed.service.updateSettings({ enabled: true, remote: '  ' }))
      .rejects.toThrow(/remote is required when the plugin is enabled/)
    await expect(composed.service.updateSettings({ cleanup: { periodHours: 0 } })).rejects.toThrow(/cleanup/)
    expect(composed.service.getSettings()).toMatchObject({ enabled: false, branch: 'trunk' })
  })

  it('commits a loader config change into the live references and keeps the last good value on a rejected one', async () => {
    previousDshHome = process.env.DSH_HOME
    const composed = await composeSessionSync({ startupSyncDelayMs: 60_000, persistence: fakePersistence() })

    await composed.loaderUpdate({ intervalMinutes: 30 })
    expect(composed.service.getSettings().intervalMinutes).toBe(30)

    // The candidate config is resolved before the commit: a section the rules
    // reject never reaches the running references.
    await composed.loaderUpdate({ enabled: true, remote: '' })
    expect(composed.service.getSettings()).toMatchObject({ enabled: false, remote: '' })
    expect(composed.service.getSettings().intervalMinutes).toBe(30)
  })

  it('re-arms the automatic cadence from a live interval change', async () => {
    previousDshHome = process.env.DSH_HOME
    const { remote, project } = await bench()
    vi.useFakeTimers()
    try {
      const composed = await composeSessionSync({
        startupSyncDelayMs: 60_000,
        persistence: fakePersistence(),
        config: {
          enabled: true,
          remote,
          branch: 'main',
          intervalMinutes: 5,
          mappings: [{ key: 'demo', path: project }],
        },
      })
      const completed: unknown[] = []
      composed.ctx.on('session-sync/completed', (payload) => { completed.push(payload) })
      // One awaited cycle first: it prepares the worktree, so the assertion
      // below observes the timer-launched cycle and not its git setup.
      await composed.service.syncNow()
      expect(completed).toHaveLength(1)

      await composed.write({ intervalMinutes: 1 })
      expect(composed.service.getSettings().intervalMinutes).toBe(1)

      // The live change re-arms the cadence: the next interval tick launches.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(composed.service.status().running).toBe(true)
      await composed.service.syncNow()
      expect(completed).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
