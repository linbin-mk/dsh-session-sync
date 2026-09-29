/**
 * Draft-and-save model for the sync settings form. The section used to commit
 * every edit on change (text fields on blur), which made a half-typed value a
 * write the host could refuse. Here the page keeps one draft, computes a patch
 * of exactly the changed fields, validates locally with the same rules the
 * host enforces, and writes once when the user saves.
 *
 * `settingsSignature` is the canonical text of the values a patch may change,
 * so "changed" costs one template string and stays correct for the nested
 * cleanup block. v2 removed the project-mapping list: what synchronizes is the
 * explicit session selection, which is not a settings field at all.
 * @module @linbin-mk/dsh-client-ui-settings-sync/settings-form
 */

import type { SyncSettingsDraft } from './controller.ts'

/** One settled validation message; `field` is the control it belongs to. */
export interface ValidationIssue {
  /** Field the message is about. */
  field: 'remote' | 'branch' | 'interval'
  /** Already-localized message. */
  message: string
}

/** Localized messages {@link validateDraft} reports. */
export interface ValidationCopy {
  /** The master switch is on, so a remote is required. */
  remoteRequired: string
  /** The branch field is blank. */
  branchBlank: string
  /** The cadence is not a positive whole number of minutes. */
  intervalInvalid: string
}

/**
 * Canonical text of the values a settings patch can change, over the *trimmed*
 * form of the text fields: the host stores trimmed values, so `" main "` and
 * `"main"` are the same setting and a stray space must not read as an edit the
 * user still has to save.
 * @param settings - the section to canonicalize.
 * @returns the canonical text.
 */
export function settingsSignature(settings: SyncSettingsDraft): string {
  const { cleanup } = settings
  return [
    settings.enabled,
    settings.remote.trim(),
    settings.branch.trim(),
    settings.intervalMinutes,
    cleanup.enabled,
    cleanup.periodHours,
    cleanup.keepCommits,
  ].join('\u0002')
}

/**
 * Whether the draft currently differs from the settings the host holds.
 * @param draft - what the form currently shows.
 * @param settings - what the host currently holds.
 * @returns whether a save would change anything.
 */
export function isDirty(draft: SyncSettingsDraft, settings: SyncSettingsDraft): boolean {
  return settingsSignature(draft) !== settingsSignature(settings)
}

/**
 * The patch that turns `settings` into `draft`, holding only the changed
 * fields. Text is trimmed here, so a trailing space the user typed never
 * reaches the host as a change of its own.
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

  return Object.keys(patch).length > 0 ? patch : undefined
}

/**
 * Rebuild an editable draft from the resolved settings section.
 * @param settings - the host's resolved section.
 * @returns a fresh draft the form may mutate.
 */
export function draftFromSettings(settings: SyncSettingsDraft): SyncSettingsDraft {
  return {
    enabled: settings.enabled,
    remote: settings.remote,
    branch: settings.branch,
    intervalMinutes: settings.intervalMinutes,
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
  return issues
}
