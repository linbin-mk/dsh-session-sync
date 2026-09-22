/** Host entry: the node half carries no behavior (the browser half owns the UI). */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-settings-sync host entry', () => {
  it('applies without host-side behavior', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
