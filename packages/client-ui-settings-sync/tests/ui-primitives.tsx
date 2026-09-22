import type { ComponentProps, ReactNode } from 'react'

export function Button(props: ComponentProps<'button'>) {
  return <button type="button" {...props} />
}

export function Input(props: ComponentProps<'input'>) {
  return <input {...props} />
}

export function Tooltip({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function IconTrashOutline16({ size }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} />
}
