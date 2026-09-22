/**
 * Snapshot-store engine for this plugin's page state.
 *
 * Vendored (trimmed) from the DeepSeek Harness snapshot-store engine
 * (`packages/client/store`, MIT, (c) DeepSeek): zustand vanilla + immer
 * produce + subscribeWithSelector, reduced to the bare observable the
 * settings page needs — `createSnapshotStore` plus the `SnapshotStore` type.
 * The published `@deepseek-ai/dsh-client-store` ships this surface only as
 * a browser bundle, so a third-party plugin that wants node-side tests
 * vendors the small engine instead of depending on the harness module
 * table. The harness slot renderer binds this identical
 * `{ getSnapshot, subscribe }` contract when the apply face declares the
 * store under its reserved inject `hooks` compartment.
 */

import { createStore, type StoreApi } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import { shallow } from 'zustand/shallow'
import { produce } from 'immer'

/** Minimal observable snapshot source: session objects and snapshot stores both satisfy it. */
export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }

/** Writable snapshot store (bare data face; the slot renderer synthesizes React selector hooks from it). */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  /**
   * Mutate the state through an immer draft.
   * @param mutator - draft mutator.
   */
  update(mutator: (draft: T) => void): void
  /**
   * Replace the state wholesale.
   * @param next - next state.
   */
  set(next: T): void
}

/**
 * Shallow equality for selector slices (zustand/shallow semantics; travels
 * with the engine so hook consumers need no zustand dependency).
 * @param a - left value.
 * @param b - right value.
 * @returns whether the values are shallowly equal.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  return shallow(a, b)
}

/** Batches subscriber notification into one flush per animation frame. */
function rafBatch(notify: () => void): () => void {
  // Fall back to microtask batching where rAF is absent (node unit tests);
  // both preserve the N-changes=1-notification contract within a tick.
  const schedule: (fn: () => void) => void =
    typeof requestAnimationFrame === 'function'
      ? (fn) => { requestAnimationFrame(() => { fn() }) }
      : (fn) => { queueMicrotask(fn) }
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    schedule(() => {
      scheduled = false
      notify()
    })
  }
}

/**
 * Create a snapshot store.
 *
 * Flush default is 'sync' (controlled inputs need same-tick echo); frame-driven
 * stores opt into 'raf', where a frame's worth of updates coalesces into one
 * notification.
 *
 * @param init - initial state.
 * @param opts - flush mode.
 * @returns the store.
 */
export function createSnapshotStore<T>(
  init: T, opts?: { flush?: 'raf' | 'sync' }): SnapshotStore<T> {
  // Immer enters through produce() in update() below (identical semantics to
  // the immer middleware without its setState-signature mutator generics).
  const withSelector = subscribeWithSelector(() => init)
  const api: StoreApi<T> = createStore<T>()(withSelector)

  let subscribe = (fn: () => void) => api.subscribe(fn)
  if (opts?.flush === 'raf') {
    const listeners = new Set<() => void>()
    const flush = rafBatch(() => { for (const fn of [...listeners]) fn() })
    api.subscribe(flush)
    subscribe = (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
  }

  return {
    getSnapshot: () => api.getState(),
    subscribe: fn => subscribe(fn),
    update: (mutator) => {
      // Immer's produce (not setState's partial-merge path) so scalar and
      // array roots replace correctly; produce also freezes in dev.
      api.setState(produce(api.getState(), (draft) => { mutator(draft as T) }), true)
    },
    set: (next) => {
      api.setState(next, true)
    },
  }
}
