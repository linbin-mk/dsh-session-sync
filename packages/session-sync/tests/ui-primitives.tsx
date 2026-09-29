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
