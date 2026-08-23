import { globalSettings } from '../settings';
import { aliasRootIndex } from '../document/schema/alias-root';
import { ReverseIncludeIndex } from '../features/navigation/reverse-include.index';
import { ActionRootingIndex } from '../mod/action-rooting.index';
import { SchemaIdIndex } from '../features/completion/schema-id.index';
import { TemplateBaseIndex } from '../features/diagnostics/template-base.index';
import { LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { MentionIndex } from '../features/navigation/mention.index';

// A scanned file's diagnostics are a pure function of its on-disk content plus the shared state
// the validators consult (settings, open buffers, the rooting and declaration indexes). The cache
// below keys on all of them, so a repeat scan skips the lex, parse, and validate work for every
// file whose inputs are unchanged. That skip is what removes the re-parse allocation churn the
// garbage collector otherwise pays for on each warm pass.

/** Bumped whenever shared validator input outside the scanned files changes: an open-buffer edit
 *  or close, a watched disk change, a configuration change, or a workspace-folder change. Any bump
 *  invalidates every cached scan result, which trades fine-grained tracking for the guarantee that
 *  a cross-file dependency can never pin a stale result. */
export let workspaceScanEpoch = 0;
/** The last seen scan-relevant settings serialization, so only a real change bumps the epoch
 *  (the whole-workspace toggle itself re-pulls configuration twice per flip). Undefined until
 *  the first configuration change establishes the baseline. */
let lastScanSettingsKey: string | undefined;

export const bumpWorkspaceScanEpoch = (): void => {
    workspaceScanEpoch++;
};

/**
 * The scan-relevant settings serialization. Only settings that change what a file's validation
 * produces participate: the whole-workspace toggle selects which files are scanned, not what a file
 * yields, and flipping it is exactly the repeat-scan case the caches exist for. The scope does
 * participate, because the duplicate-field pass compares a file against the other files the game
 * loads, so narrowing or widening the scope changes what that file itself reports. The l10n bundle
 * path rides along because persisted diagnostics carry localized messages.
 *
 * @returns the serialized key.
 */
export const scanSettingsKeyOf = (): string =>
    JSON.stringify({
        ...globalSettings,
        diagnostics: {
            ...globalSettings.diagnostics,
            validateWholeWorkspace: undefined,
        },
        l10nBundle: process.env['EXTENSION_BUNDLE_PATH'] ?? '',
    });

/**
 * Compares the scan-relevant settings against the last seen ones and stales every cached scan
 * result when they moved. The first call only establishes the baseline: nothing was scanned under
 * an earlier key yet.
 */
export function noteScanSettingsChange(): void {
    const scanSettingsKey = scanSettingsKeyOf();
    if (lastScanSettingsKey === undefined) {
        lastScanSettingsKey = scanSettingsKey;
    } else if (scanSettingsKey !== lastScanSettingsKey) {
        lastScanSettingsKey = scanSettingsKey;
        bumpWorkspaceScanEpoch();
    }
}

/**
 * The combined revision of every index whose content feeds scanned diagnostics. Captured before a
 * file validates and compared after: a result computed while an index was still ingesting must not
 * be stored, and a stored result is only served while every index is where it was.
 *
 * @returns the sum of the participating index revisions.
 */
export const scanRevisionSum = (): number =>
    aliasRootIndex.revision +
    ReverseIncludeIndex.instance.revision +
    ActionRootingIndex.instance.revision +
    SchemaIdIndex.instance.revision +
    TemplateBaseIndex.instance.revision +
    LocalizationKeyIndex.instance.revision +
    MentionIndex.instance.revision;

