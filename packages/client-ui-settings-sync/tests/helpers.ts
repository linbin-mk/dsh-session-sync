/**
 * Test doubles for the harness client services this plugin consumes at
 * registration time (slots, locale, remote) plus the translate helper the
 * component specs share. The published harness packages ship those runtime
 * surfaces only as browser bundles, so third-party node-side tests exercise
 * the plugin against these minimal contracts instead — the real slot core
 * and locale runtime stay covered by the harness integration.
 */

import { useMemo, useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Bind a bare snapshot source to a selector hook. Vendored from the retired
 * harness web-react helper for node-side component tests: the browser slot
 * renderer performs the same binding for sources declared in an entry's
 * inject `hooks` compartment, which tests assemble by hand instead.
 * @param source - observable snapshot source (getSnapshot + subscribe).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(
  source: { getSnapshot(): T; subscribe(fn: () => void): () => void },
): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => source.subscribe(fn)
  const getSnapshot = () => source.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot)
    // Re-select only when the snapshot or the selector/equality change.
    return useMemo(() => sel(snapshot), [snapshot, sel, eq])
  }
}

/** Interpolate `{key}` placeholders with their parameter values. */
export function makeTranslate(dictionary: Record<string, string>) {
  return (key: keyof typeof dictionary, params?: Record<string, unknown>): string => {
    const template = dictionary[key] ?? String(key)
    return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
      params !== undefined && params[name] !== undefined ? String(params[name]) : `{${name}}`)
  }
}

/** One registered slot entry the fake slots ledger keeps. */
export interface FakeSlotEntry {
  name: string
  id: string
  order: number
  label: (() => string) | undefined
  inject: (() => Record<string, unknown>) | undefined
  component: unknown
}

/**
 * Minimal `slots` service: declarations, entries, and the inject-on-declare
 * ordering the plugin relies on. Fiber-scoped disposal of injected
 * registrations is slot-core behavior and is not replicated here.
 */
export class FakeSlots {
  private readonly declared = new Set<string>()
  private readonly ledger = new Map<string, FakeSlotEntry[]>()
  private readonly pending = new Map<string, Array<() => void>>()

  /** Declare a slot list entry (the settings shell and sidebar foot do this). */
  declare(name: string): void {
    this.declared.add(name)
    if (!this.ledger.has(name)) this.ledger.set(name, [])
    const waiting = this.pending.get(name) ?? []
    this.pending.delete(name)
    for (const run of waiting) run()
  }

  /** Register one slot entry (the plugin's contribution). */
  register(entry: { name: string; id: string; order?: number; label?: () => string; inject?: () => Record<string, unknown> }, component: unknown): () => void {
    const record: FakeSlotEntry = {
      name: entry.name,
      id: entry.id,
      order: entry.order ?? 0,
      label: entry.label,
      inject: entry.inject,
      component,
    }
    const list = this.ledger.get(entry.name) ?? []
    list.push(record)
    this.ledger.set(entry.name, list)
    return () => {
      const at = list.indexOf(record)
      if (at !== -1) list.splice(at, 1)
    }
  }

  /** Register now if the slot is declared, otherwise once it is. */
  inject(name: string, factory: () => void): void {
    if (this.declared.has(name)) {
      factory()
      return
    }
    const waiting = this.pending.get(name) ?? []
    waiting.push(factory)
    this.pending.set(name, waiting)
  }

  /** The entries currently registered under one slot name. */
  entries(name: string): FakeSlotEntry[] {
    return this.ledger.get(name) ?? []
  }
}

/** Minimal `locale` service: registers dictionaries and binds the Chinese copy. */
export class FakeLocale {
  private readonly dictionaries = new Map<string, { en: Record<string, string>; zh: Record<string, string> }>()

  register(ns: string, dictionaries: { en: Record<string, string>; zh: Record<string, string> }): void {
    this.dictionaries.set(ns, dictionaries)
  }

  /** Bind a translate for one namespace; the specs assume the pinned zh-CN browser. */
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    return (key, params) => {
      const dictionary = this.dictionaries.get(ns)
      const template = dictionary === undefined ? key : (dictionary.zh[key] ?? key)
      return makeTranslate({ [key]: template })(key as never, params)
    }
  }
}

/** Minimal `remote` service: records listeners and dispatches payloads at them. */
export class FakeRemote {
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>()

  $on(event: string, listener: (payload: unknown) => void): () => void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => {
      const at = list.indexOf(listener)
      if (at !== -1) list.splice(at, 1)
    }
  }

  $dispatch(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }
}
