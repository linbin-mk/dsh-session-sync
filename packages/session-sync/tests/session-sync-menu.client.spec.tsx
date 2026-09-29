// @vitest-environment jsdom
/**
 * Session row-menu entry: the three states the entry may present — 「同步会话」
 * for an unselected session, 「会话同步中」 for a selected one, and nothing at
 * all for an unconfigured plugin or a session this machine does not hold — plus
 * the two clicks (select + close the menu, or raise the records request).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from './helpers.ts'
import { SessionSyncMenuItem } from '../src/client/SessionSyncMenuItem.tsx'
import type { SessionSyncMenuItemProps } from '../src/client/SessionSyncMenuItem.tsx'
import type { SyncMenuState } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh) as NonNullable<SessionSyncMenuItemProps['t']>

/** One menu-state projection, with the common case (configured, unselected) as the default. */
function menu(overrides: Partial<SyncMenuState> = {}): SyncMenuState {
  return { configured: true, selected: new Set<string>(), unheld: new Set<string>(), ...overrides }
}

/** Mount the entry over a fixed menu projection and spy callbacks. */
function mount(m: SyncMenuState, props: Partial<SessionSyncMenuItemProps> = {}) {
  const selectSession = vi.fn()
  const requestRecords = vi.fn()
  const setMenuOpen = vi.fn()
  const view = render(
    <SessionSyncMenuItem
      // The real row hands over a branded SessionId; the spec supplies one.
      sessionId={'s1' as SessionSyncMenuItemProps['sessionId']}
      displayTitle="Demo session"
      // The renderer binds the slot-level hook from the row's hookContext and
      // the inject source into a selector hook; the spec supplies both.
      useMenuOpenState={() => [true, setMenuOpen] as const}
      useMenu={((selector: (state: SyncMenuState) => unknown) => selector(m)) as never}
      selectSession={selectSession}
      requestRecords={requestRecords}
      t={t}
      {...props}
    />,
  )
  return { view, selectSession, requestRecords, setMenuOpen }
}

describe('SessionSyncMenuItem', () => {
  it('renders one menuitem row named 「同步会话」 for an unselected session', () => {
    mount(menu())
    const row = screen.getByRole('menuitem')
    expect(row.textContent).toBe(t('menuSync'))
    expect(screen.queryByText(t('menuSyncing'))).toBeNull()
  })

  it('renders nothing before the slot injects its dependencies', () => {
    render(<SessionSyncMenuItem />)
    expect(document.body.textContent).toBe('')
  })

  it('renders nothing while the plugin is unconfigured', () => {
    mount(menu({ configured: false }))
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it('renders nothing for a selected session this machine does not hold', () => {
    mount(menu({ selected: new Set(['s1']), unheld: new Set(['s1']) }))
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('still offers the entry for a selected session this machine holds', () => {
    mount(menu({ selected: new Set(['s1']) }))
    expect(screen.getByRole('menuitem').textContent).toBe(t('menuSyncing'))
  })

  it('offers the entry for a local session the selection does not mention', () => {
    // Absence from the tree is the normal state of a local row: only a tree row
    // reporting present:false can prove the machine does not hold a session.
    mount(menu({ selected: new Set(['other']), unheld: new Set(['other']) }))
    expect(screen.getByRole('menuitem').textContent).toBe(t('menuSync'))
  })

  it('selects the session and closes the menu on 「同步会话」', () => {
    const { selectSession, requestRecords, setMenuOpen } = mount(menu())
    fireEvent.click(screen.getByRole('menuitem'))
    expect(selectSession).toHaveBeenCalledWith('s1')
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    // Selecting starts sync; it does not open the records dialog.
    expect(requestRecords).not.toHaveBeenCalled()
  })

  it('raises the records request and closes the menu on 「会话同步中」', () => {
    const { selectSession, requestRecords, setMenuOpen } = mount(menu({ selected: new Set(['s1']) }))
    fireEvent.click(screen.getByRole('menuitem'))
    expect(requestRecords).toHaveBeenCalledWith('s1', 'Demo session')
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(selectSession).not.toHaveBeenCalled()
  })

  it('passes an empty row title through, so the dialog can fall back to the id', () => {
    const { requestRecords } = mount(menu({ selected: new Set(['s1']) }), { displayTitle: '' })
    fireEvent.click(screen.getByRole('menuitem'))
    expect(requestRecords).toHaveBeenCalledWith('s1', '')
  })

  it('ignores a click while the inject face is incomplete', () => {
    const selectSession = vi.fn()
    render(
      <SessionSyncMenuItem
        sessionId={'s1' as SessionSyncMenuItemProps['sessionId']}
        displayTitle="Demo"
        selectSession={selectSession}
      />,
    )
    expect(selectSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
