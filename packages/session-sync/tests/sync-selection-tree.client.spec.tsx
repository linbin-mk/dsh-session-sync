// @vitest-environment jsdom
/**
 * The synced-session collection tree: the workspace groups, the session rows
 * (status dot, trailing relative time, the row menu), the unmatched groups that
 * replace the old standalone pending list, and the empty state.
 *
 * The tree is mounted directly, so no controller or route double is involved:
 * every action arrives as a callback and every fact as a prop. Relative-time
 * fixtures are placed relative to the wall clock the tree buckets against.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate, selectionSession, selectionView } from './helpers.ts'
import { SyncSelectionTree } from '../src/client/SyncSelectionTree.tsx'
import type { SyncSelectionTreeProps } from '../src/client/SyncSelectionTree.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as SyncSelectionTreeProps['t']

/** Mount the tree over one selection with inert actions. */
function mount(selection: Parameters<typeof selectionView>[0], overrides: Partial<SyncSelectionTreeProps> = {}) {
  const onCloseSync = vi.fn()
  const onOpenRecords = vi.fn()
  const view = render(
    <SyncSelectionTree
      selection={selectionView(selection)}
      closing={null}
      onCloseSync={onCloseSync}
      onOpenRecords={onOpenRecords}
      t={t}
      {...overrides}
    />,
  )
  return { view, onCloseSync, onOpenRecords }
}

describe('SyncSelectionTree', () => {
  it('shows the empty state while nothing is selected', () => {
    mount({})
    expect(screen.getByText(t('selectionEmptyTitle'))).toBeTruthy()
    expect(screen.getByText(t('selectionEmptyHint'))).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a workspace group with its session rows and trailing count', () => {
    mount({
      workspaces: [{
        key: 'ws-1',
        name: 'dsh-session-sync',
        matched: true,
        matches: 1,
        sessions: [
          selectionSession({ id: 's1', title: '置顶功能插槽点分析' }),
          selectionSession({ id: 's2', title: 'only-in-repo', present: false }),
        ],
      }],
      total: 2,
    })
    const group = screen.getByRole('button', { name: /dsh-session-sync/ })
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(within(group).getByText('2')).toBeTruthy()
    expect(screen.getByText('置顶功能插槽点分析')).toBeTruthy()
    // A session the repo knows but this machine never titled falls back to its id.
    expect(screen.getByText('only-in-repo')).toBeTruthy()
  })

  it('dates a row by its newest synchronization and falls back to when it joined', () => {
    // The tree buckets against the wall clock, so the fixtures are placed
    // relative to it and land in the same bucket whenever the spec runs.
    const now = Date.now()
    const fiveMinutes = new Date(now - 5 * 60_000).toISOString()
    const fourteenDays = new Date(now - 14 * 86_400_000).toISOString()
    mount({
      workspaces: [{
        key: 'ws-1',
        name: 'demo',
        matched: true,
        matches: 1,
        sessions: [
          selectionSession({ id: 's1', title: 'synced', lastSyncAt: fiveMinutes }),
          // No recorded synchronization: the row dates itself from addedAt.
          selectionSession({ id: 's2', title: 'added', addedAt: fourteenDays }),
          // Neither instant: the trailing cell stays empty rather than inventing one.
          selectionSession({ id: 's3', title: 'undated' }),
        ],
      }],
      total: 3,
    })
    expect(screen.getByText(t('timeAgo', { t: t('timeMinutes', { n: 5 }) }))).toBeTruthy()
    expect(screen.getByText(t('timeAgo', { t: t('timeDays', { n: 14 }) }))).toBeTruthy()
    expect(screen.getByText('undated')).toBeTruthy()
  })

  it('keeps every recorded fact reachable as the row tooltip', () => {
    mount({
      workspaces: [{
        key: 'ws-1',
        name: 'demo',
        matched: true,
        matches: 1,
        sessions: [selectionSession({
          id: 's1',
          title: 'Demo session',
          addedAt: '2026-09-29T09:59:00.000Z',
          addedBy: 'machine-a',
          lastSyncAt: '2026-09-29T10:20:00.000Z',
          lastSyncHost: 'machine-b',
          conflicts: 2,
        })],
      }],
      total: 1,
    })
    const tooltip = [
      t('sessionAddedAt', { time: new Date('2026-09-29T09:59:00.000Z').toLocaleString() }),
      t('sessionAddedBy', { host: 'machine-a' }),
      t('sessionLastSync', {
        host: 'machine-b',
        time: new Date('2026-09-29T10:20:00.000Z').toLocaleString(),
      }),
      t('sessionConflict', { count: 2 }),
    ].join(' · ')
    expect(screen.getByTitle(tooltip)).toBeTruthy()
  })

  it('carries the conflict and not-held states as labelled status dots', () => {
    mount({
      workspaces: [{
        key: 'ws-1',
        name: 'demo',
        matched: true,
        matches: 1,
        sessions: [
          selectionSession({ id: 's1', title: 'conflicted', conflicts: 3 }),
          selectionSession({ id: 's2', title: 'not-here', present: false }),
          selectionSession({ id: 's3', title: 'healthy' }),
        ],
      }],
      total: 3,
    })
    // A conflict outranks the not-held state, and a healthy row leaves the slot
    // empty so the titles stay aligned.
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByRole('img', { name: t('sessionConflict', { count: 3 }) })).toBeTruthy()
    expect(screen.getByRole('img', { name: t('sessionNotPresent') })).toBeTruthy()
  })

  it('opens the row menu and reports its two verbs', () => {
    const { onCloseSync, onOpenRecords } = mount({
      workspaces: [{
        key: 'ws-1',
        name: 'demo',
        matched: true,
        matches: 1,
        sessions: [selectionSession({ id: 's1', title: 'Demo session' })],
      }],
      total: 1,
    })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('sessionMenuAria', { name: 'Demo session' }) }))
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: t('viewRecords') }))
    expect(onOpenRecords).toHaveBeenCalledWith('s1', 'Demo session')
    expect(onCloseSync).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: t('sessionMenuAria', { name: 'Demo session' }) }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: t('closeSync') }))
    expect(onCloseSync).toHaveBeenCalledWith('s1')
  })

  it('holds the close verb while that session write is in flight', () => {
    mount({
      workspaces: [{
        key: 'ws-1',
        name: 'demo',
        matched: true,
        matches: 1,
        sessions: [selectionSession({ id: 's1', title: 'Demo session' })],
      }],
      total: 1,
    }, { closing: 's1' })
    fireEvent.click(screen.getByRole('button', { name: t('sessionMenuAria', { name: 'Demo session' }) }))
    expect(screen.getByRole('menuitem', { name: t('closeSync') })).toHaveProperty('disabled', true)
  })

  it('folds and unfolds a group without losing its rows', () => {
    mount({
      workspaces: [{
        key: 'ws-1',
        name: 'demo',
        matched: true,
        matches: 1,
        sessions: [selectionSession({ id: 's1', title: 'Demo session' })],
      }],
      total: 1,
    })
    const group = screen.getByRole('button', { name: /demo/ })
    fireEvent.click(group)
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Demo session')).toBeNull()
    fireEvent.click(group)
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Demo session')).toBeTruthy()
  })

  it('warns on a group no local workspace carries, and on an ambiguous name', () => {
    mount({
      workspaces: [
        { key: 'ws-1', name: 'renamed-locally', matched: false, matches: 0, sessions: [selectionSession({ id: 's1' })] },
        { key: 'ws-2', name: 'twice', matched: false, matches: 2, sessions: [selectionSession({ id: 's2' })] },
      ],
      total: 2,
    })
    expect(screen.getByText(t('workspaceUnmatched'))).toBeTruthy()
    expect(screen.getByText(t('workspaceAmbiguous'))).toBeTruthy()
  })

  it('renders an unmatched repo workspace in place, with its remedy and no binding verb', () => {
    mount({
      workspaces: [{
        key: 'ws-1',
        name: 'not-here',
        matched: false,
        matches: 0,
        sessions: [selectionSession({ id: 's1', present: false }), selectionSession({ id: 's2', present: false })],
      }],
      // The host repeats these groups in `pending`; the tree renders one row
      // per workspace, never two.
      pending: [{ key: 'ws-1', name: 'not-here', sessionIds: ['s1', 's2'], matches: 0 }],
      total: 2,
    })
    expect(screen.getAllByText('not-here')).toHaveLength(1)
    expect(screen.getByText(t('workspaceUnmatched'))).toBeTruthy()
    expect(screen.getByText(t('pendingHint'))).toBeTruthy()
    const group = screen.getByRole('button', { name: /not-here/ })
    expect(within(group).getByText('2')).toBeTruthy()
    // Folding the group keeps the remedy visible: it explains the group, not
    // the rows underneath it.
    fireEvent.click(group)
    expect(screen.getByText(t('pendingHint'))).toBeTruthy()
    expect(screen.queryByText('s1')).toBeNull()
    // No binding affordance exists: creating a same-named workspace is the
    // whole remedy.
    expect(screen.queryByRole('button', { name: /绑定|bind/i })).toBeNull()
  })

  it('lists a workspace group per repo key, in the order the repo stores them', () => {
    mount({
      workspaces: [
        { key: 'ws-b', name: 'second', matched: true, matches: 1, sessions: [selectionSession({ id: 's2' })] },
        { name: 'local-only', matched: true, matches: 1, sessions: [selectionSession({ id: 's3' })] },
        { key: 'ws-a', name: 'first', matched: true, matches: 1, sessions: [selectionSession({ id: 's1' })] },
      ],
      total: 3,
    })
    // Group rows are the labelled buttons; the unlabelled ones are row menus.
    const names = screen.getAllByRole('button')
      .map(button => button.textContent ?? '')
      .filter(text => text.length > 0)
      .map(text => text.replace(/\d+$/, ''))
    expect(names).toEqual(['second', 'local-only', 'first'])
  })
})
