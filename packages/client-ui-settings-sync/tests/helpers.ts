/**
 * Test doubles for the harness client services this plugin consumes at
 * registration time (slots, locale, remote, configForms) plus the translate
 * helper the component specs share. The published harness packages ship those
 * runtime surfaces only as browser bundles, so third-party node-side tests
 * exercise the plugin against these minimal contracts instead — the real slot
 * core and locale runtime stay covered by the harness integration.
 */

import { useMemo, useSyncExternalStore } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
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

/** Options of {@link FakeConfigForm}. */
export interface FakeConfigFormOptions<T = Record<string, unknown>> {
  /** Section the Host serves; fields may be absent (the page decodes fallbacks). Omit to model an entry this client is not served. */
  value?: Record<string, unknown>
  /** Whether the Host document accepts writes; defaults to the section's presence. */
  writable?: boolean
  /** `host` syncs with the Host document; `memory` keeps the page process-local. */
  mode?: 'host' | 'memory'
}

/** Lay one path op over a section the way the Host document merges it. */
function applyOp(value: Record<string, unknown> | undefined, op: SettingsPathOpView): Record<string, unknown> {
  const section = value === undefined ? {} : structuredClone(value)
  const [head, ...rest] = op.path
  if (head === undefined) return op.op === 'set' ? op.value as Record<string, unknown> : {}
  if (rest.length === 0) {
    if (op.op === 'unset') Reflect.deleteProperty(section, head)
    else section[head] = structuredClone(op.value)
    return section
  }
  const current = section[head]
  const nested = current !== null && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
  section[head] = applyOp(nested, { op: op.op, path: rest, ...op.op === 'set' ? { value: op.value } : {} } as SettingsPathOpView)
  return section
}

/**
 * Minimal configuration form: one Host entry's section with the shared form's
 * read face, subscribe, and one atomic write. Accepted writes land in the
 * section the snapshot serves, so a page reloading after a write observes
 * exactly what a Host commit would publish.
 */
export class FakeConfigForm<T = Record<string, unknown>> implements ConfigForm<T> {
  /** Path ops every accepted write carried, in order. */
  readonly writes: SettingsPathOpView[][] = []
  /** Snapshot reads the page performed (a reload reads once). */
  reads = 0
  /** Message the next write rejects with; consumed by that write. */
  writeError: string | undefined
  /** Whether writes are skipped, as a process-local page's form does. */
  skipWrites = false
  /** Whether the Host refuses writes, as its validators do (the form reports `false`). */
  refuseWrites = false
  private snapshot: ConfigFormSnapshot<T>
  private readonly listeners = new Set<() => void>()

  /** @param options - served section, writability, and persistence mode. */
  constructor(options: FakeConfigFormOptions<T> = {}) {
    this.snapshot = {
      status: options.value === undefined ? 'unavailable' : 'ready',
      value: options.value as T | undefined,
      base: undefined,
      user: undefined,
      revision: options.value === undefined ? undefined : 1,
      writable: (options.mode ?? 'host') === 'memory' ? false : options.writable ?? true,
      mode: options.mode ?? 'host',
    }
  }

  getSnapshot(): ConfigFormSnapshot<T> {
    this.reads += 1
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(field: string, value: unknown): Promise<boolean> {
    // The form's wire value type is JSON data the caller supplies; the page
    // routes every edit through `mutate`, so this only keeps the interface.
    return this.mutate([{ op: 'set', path: [field], value: value as Extract<SettingsPathOpView, { op: 'set' }>['value'] }])
  }

  unset(field: string): Promise<boolean> {
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  async mutate(ops: readonly SettingsPathOpView[]): Promise<boolean> {
    if (this.writeError !== undefined) {
      const message = this.writeError
      this.writeError = undefined
      throw new Error(message)
    }
    if (this.refuseWrites || this.skipWrites || this.snapshot.mode === 'memory') return false
    this.writes.push([...ops])
    let next = this.snapshot.value as Record<string, unknown> | undefined
    for (const op of ops) next = applyOp(next, op)
    this.publish(next)
    return true
  }

  /** Publish a section as a Host commit would (another editor's write). */
  publish(value: Record<string, unknown> | undefined): void {
    this.snapshot = {
      ...this.snapshot,
      status: value === undefined ? 'unavailable' : 'ready',
      value: value as T | undefined,
      revision: value === undefined ? this.snapshot.revision : (this.snapshot.revision ?? 0) + 1,
    }
    for (const listener of this.listeners) listener()
  }
}

/** The plain-object patch one recorded write carried (the page writes one `set` op per field). */
export function writtenPatch(form: { writes: SettingsPathOpView[][] }, index = -1): Record<string, unknown> {
  const ops = form.writes.at(index) ?? []
  const patch: Record<string, unknown> = {}
  for (const op of ops) {
    if (op.op !== 'set' || op.path.length !== 1) continue
    patch[op.path[0]!] = op.value
  }
  return patch
}

/** Minimal `configForms` service: hands out one form per Host entry id. */
export class FakeConfigForms {
  /** Entry ids the plugin asked for, in order. */
  readonly requested: string[] = []
  private readonly forms = new Map<string, FakeConfigForm>()

  /** The shared form of one entry, created on first request. */
  get<T>(entryId: string): ConfigForm<T> {
    this.requested.push(entryId)
    return this.form(entryId) as unknown as ConfigForm<T>
  }

  /** The concrete double of one entry, for a spec to drive. */
  form(entryId: string): FakeConfigForm {
    const existing = this.forms.get(entryId)
    if (existing !== undefined) return existing
    const form = new FakeConfigForm()
    this.forms.set(entryId, form)
    return form
  }
}
