import type { ComponentProps, ReactNode } from 'react'

export function Button(props: ComponentProps<'button'>) {
  return <button type="button" {...props} />
}

export function Input(props: ComponentProps<'input'>) {
  return <input {...props} />
}

/**
 * One row of a dropdown menu. The real primitive renders
 * `<button role="menuitem">` inside a separator wrapper and owns the styling;
 * the double keeps the role and the click handler, which is all a row-menu
 * spec observes.
 */
export function MenuItemButton({
  children, onSelect, disabled = false, separatorBefore = false, icon, shortcut,
}: {
  children?: ReactNode
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  icon?: ReactNode
  shortcut?: unknown
}) {
  return (
    <>
      {separatorBefore && <div role="separator" />}
      <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}>
        {icon}
        {children}
        {shortcut !== undefined && <span aria-hidden="true" />}
      </button>
    </>
  )
}

/**
 * The real Modal portals a card over a mask and owns focus/Escape handling;
 * the double renders the same observable surface — heading, accessible close
 * button, body, footer — inline, so a spec can query it in jsdom.
 */
export function Modal({
  open, onClose, title, closeLabel, description, children, footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  shortcutModal?: string
  backdropBlur?: boolean
  headless?: boolean
}) {
  if (!open) return null
  return (
    <div role="dialog" aria-label={title} data-modal="">
      <button type="button" aria-label={closeLabel} onClick={onClose} />
      <h2>{title}</h2>
      {description !== undefined && description !== '' && <p>{description}</p>}
      <div data-modal-body="">{children}</div>
      {footer !== undefined && <div data-modal-footer="">{footer}</div>}
    </div>
  )
}

/**
 * The real Switch is a `role="switch"` button keyed by aria-checked; the double
 * keeps exactly that contract, because every spec reaches for it by role and
 * name and reads its state through aria-checked.
 */
export function Switch({
  checked, onChange, label, disabled = false, title, className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      className={className}
      onClick={() => { onChange(!checked) }}
    />
  )
}

/** The real Tag is a capsule span whose palette rides `data-tone`. */
export function Tag({ tone = 'outline', className, children }: {
  tone?: string
  className?: string
  children?: ReactNode
}) {
  return <span data-tone={tone} className={className}>{children}</span>
}

/** The real StateDot paints a 6px currentColor core keyed by `data-state`. */
export function StateDot({ state, size, className }: {
  state: string
  size?: number
  className?: string
  appearance?: 'dot' | 'step'
}) {
  return <span data-state={state} data-size={size} className={className} />
}

/**
 * The real Menu portals an anchored dropdown whose rows are data entries or
 * component rows. The double renders the anchor with the same inline list, so a
 * spec can click the trigger and then the row without reproducing placement,
 * dismissal, or the keyboard walk.
 */
export function Menu({
  open, anchor, items = [], children, onSelect, onClose, className,
}: {
  open: boolean
  anchor: ReactNode
  items?: readonly { id: string; label: ReactNode; disabled?: boolean }[]
  children?: ReactNode
  onSelect?: (id: string) => void
  onClose?: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  portal?: boolean
  closeOnPointerLeave?: boolean
  dense?: boolean
  compact?: boolean
  className?: string
}) {
  return (
    <span className={className}>
      {anchor}
      {open && (
        <div role="menu">
          {onClose !== undefined && <button type="button" aria-label="close-menu" onClick={onClose} />}
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled === true}
              onClick={() => { onSelect?.(item.id) }}
            >
              {item.label}
            </button>
          ))}
          {children}
        </div>
      )}
    </span>
  )
}

/**
 * Compact relative-time bucketing, mirroring the primitive the shipped sidebar
 * dates its rows with (`now` / minutes / hours / days / months / years) so the
 * specs pin the same buckets the real surface produces.
 */
export function relativeTime(at: number, now: number): { unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'; n: number } {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - at)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

/** One icon double: the glyph identity is all a spec asserts. */
function icon(name: string) {
  return function Icon({ className }: { size?: number; className?: string }) {
    return <svg data-icon={name} className={className} />
  }
}

export const IconFolderOpenRegular = icon('IconFolderOpenRegular')
export const IconFolderCloseRegular = icon('IconFolderCloseRegular')
export const IconTriangleRightFillRegular = icon('IconTriangleRightFillRegular')
export const IconEllipsisOutlineRegular = icon('IconEllipsisOutlineRegular')
