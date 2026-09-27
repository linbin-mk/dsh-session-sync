/**
 * Draft-and-save model for the sync settings form. The section used to commit
 * every edit on change (text fields on blur), which made a half-typed value a
 * write the host could refuse — and made adding a second project mapping
 * impossible, because the new row arrived at the host already carrying the
 * first row's path, so every add collided with it. Here the page keeps one
 * draft, computes a patch of exactly the changed fields, validates locally
 * with the same rules the host enforces, and writes once when the user saves.
 *
 * `settingsSignature` is the canonical text of the values a patch may change,
 * so "changed" costs one template string and stays correct for the nested
 * values (the cleanup block, the mapping list).
 * @module @linbin-mk/dsh-client-ui-settings-sync/settings-form
 */

import type { SyncSettingsDraft } from './controller.ts'

/** One settled validation message; `field` is the control it belongs to. */
export interface ValidationIssue {
  /** Field the message is about. */
  field: 'remote' | 'branch' | 'interval' | 'mappings'
  /** Already-localized message. */
  message: string
}

/** Localized messages {@link validateDraft} reports. */
export interface ValidationCopy {
  /** The master switch is on, so a remote is required. */
  remoteRequired: string
  /** The branch field is blank. */
  branchBlank: string
  /** Every mapping row needs a key. */
  mappingKeyBlank: (row: number) => string
  /** Every mapping row needs a directory. */
  mappingPathBlank: (row: number) => string
  /** Two rows use the same key. */
  mappingKeyDuplicate: (key: string) => string
  /** Two rows use the same directory. */
  mappingPathDuplicate: (path: string) => string
  /** The cadence is not a positive whole number of minutes. */
  intervalInvalid: string
}

/**
 * Canonical text of the values a settings patch can change, over the *trimmed*
 * form of the text fields: the host stores trimmed values, so `" main "` and
 * `"main"` are the same setting and a stray space must not read as an edit the
 * user still has to save.
 */
export function settingsSignature(settings: SyncSettingsDraft): string {
  const mappings = settings.mappings
    .map(mapping => `${mapping.key.trim()}\u0000${mapping.path.trim()}`)
    .join('\u0001')
  const { cleanup } = settings
  return [
    settings.enabled,
    settings.remote.trim(),
    settings.branch.trim(),
    settings.intervalMinutes,
    cleanup.enabled,
    cleanup.periodHours,
    cleanup.keepCommits,
    mappings,
  ].join('\u0002')
}

/** Whether the draft currently differs from the settings the host holds. */
export function isDirty(draft: SyncSettingsDraft, settings: SyncSettingsDraft): boolean {
  return settingsSignature(draft) !== settingsSignature(settings)
}

/** The mapping list with trimmed text, the form the host stores. */
export function cleanMappings(mappings: readonly { key: string; path: string }[]): { key: string; path: string }[] {
  return mappings.map(mapping => ({ key: mapping.key.trim(), path: mapping.path.trim() }))
}

/**
 * The patch that turns `settings` into `draft`, holding only the changed
 * fields. Mapping text is trimmed here, so a trailing space the user typed
 * never reaches the host as a change of its own.
 * @param draft - what the form currently shows.
 * @param settings - what the host currently holds.
 * @returns a patch for the settings write, or `undefined` when nothing changed.
 */
export function settingsPatch(
  draft: SyncSettingsDraft,
  settings: SyncSettingsDraft,
): Record<string, unknown> | undefined {
  if (!isDirty(draft, settings)) return undefined
  const patch: Record<string, unknown> = {}
  if (draft.enabled !== settings.enabled) patch['enabled'] = draft.enabled
  if (draft.remote.trim() !== settings.remote.trim()) patch['remote'] = draft.remote.trim()
  if (draft.branch.trim() !== settings.branch.trim()) patch['branch'] = draft.branch.trim()
  if (draft.intervalMinutes !== settings.intervalMinutes) patch['intervalMinutes'] = draft.intervalMinutes
  const cleanup: Record<string, unknown> = {}
  if (draft.cleanup.enabled !== settings.cleanup.enabled) cleanup['enabled'] = draft.cleanup.enabled
  if (draft.cleanup.periodHours !== settings.cleanup.periodHours) cleanup['periodHours'] = draft.cleanup.periodHours
  if (draft.cleanup.keepCommits !== settings.cleanup.keepCommits) cleanup['keepCommits'] = draft.cleanup.keepCommits
  if (Object.keys(cleanup).length > 0) patch['cleanup'] = cleanup
  const mappings = cleanMappings(draft.mappings)
  if (JSON.stringify(mappings) !== JSON.stringify(cleanMappings(settings.mappings))) {
    patch['mappings'] = mappings
  }

  return Object.keys(patch).length > 0 ? patch : undefined
}

/** Rebuild an editable draft from the resolved settings section. */
export function draftFromSettings(settings: SyncSettingsDraft): SyncSettingsDraft {
  return {
    enabled: settings.enabled,
    remote: settings.remote,
    branch: settings.branch,
    intervalMinutes: settings.intervalMinutes,
    mappings: settings.mappings.map(mapping => ({ key: mapping.key, path: mapping.path })),
    cleanup: {
      enabled: settings.cleanup.enabled,
      periodHours: settings.cleanup.periodHours,
      keepCommits: settings.cleanup.keepCommits,
    },
  }
}

/**
 * Syntax and cross-field validation over the draft, mirroring the rules the
 * host enforces so a mistake is named next to its own field instead of
 * arriving as one opaque write error after a round trip. It never rejects a
 * value the host would accept.
 * @param draft - the draft to check.
 * @param copy - localized messages.
 * @returns every issue found, in field order.
 */
export function validateDraft(draft: SyncSettingsDraft, copy: ValidationCopy): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (draft.remote.trim().length === 0 && draft.enabled) {
    issues.push({ field: 'remote', message: copy.remoteRequired })
  }
  if (draft.branch.trim().length === 0) issues.push({ field: 'branch', message: copy.branchBlank })
  if (!Number.isInteger(draft.intervalMinutes) || draft.intervalMinutes < 1) {
    issues.push({ field: 'interval', message: copy.intervalInvalid })
  }
  const keys = new Set<string>()
  const paths = new Set<string>()
  draft.mappings.forEach((mapping, index) => {
    const key = mapping.key.trim()
    const path = mapping.path.trim()
    const row = index + 1
    if (key.length === 0) issues.push({ field: 'mappings', message: copy.mappingKeyBlank(row) })
    else if (keys.has(key)) issues.push({ field: 'mappings', message: copy.mappingKeyDuplicate(key) })
    else keys.add(key)
    if (path.length === 0) issues.push({ field: 'mappings', message: copy.mappingPathBlank(row) })
    else if (paths.has(path)) issues.push({ field: 'mappings', message: copy.mappingPathDuplicate(path) })
    else paths.add(path)
  })
  return issues
}
