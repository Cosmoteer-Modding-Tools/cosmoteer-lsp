import { ExtensionContext, Uri, l10n, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { creationFailureMessage, wiringNotes } from './nebula-wizard';
import { applyForWizard, scanForWizard, wizardAnchor } from './wizard-client';
import { escapeHtml, scriptJson, showWizardForm } from './wizard-form';
import { GalaxySizeForm, NewGalaxySizeApplyResult, NewGalaxySizeScanResult } from './galaxy-size-wizard.types';

/**
 * Creating a galaxy size: a name and a number of systems. The server clones the game's standard
 * map generator with that count, writes the size entry and its texts, and offers the size to the
 * career and creative modes from the manifest.
 */

/** The palette command, distinct from the server's own command id. */
export const NEW_GALAXY_SIZE_LOCAL_COMMAND = 'cosmoteer.newGalaxySize.create';

/** The server command the wrapper runs. */
const NEW_GALAXY_SIZE_SERVER_COMMAND = 'cosmoteer.newGalaxySize';

/**
 * Creates a galaxy size in the mod of the active document.
 *
 * @param context the extension context, for the form.
 * @param client the language client the command runs through.
 * @param anchor the uri the mod is found from, absent to find it from the editor.
 */
export async function createNewGalaxySize(
    context: ExtensionContext,
    client: LanguageClient,
    anchor?: string
): Promise<void> {
    const uri = wizardAnchor(anchor);
    if (!uri) return;
    const scan = await scanForWizard<NewGalaxySizeScanResult>(
        client,
        NEW_GALAXY_SIZE_SERVER_COMMAND,
        uri,
        creationFailureMessage
    );
    if (!scan) return;
    const modName = scan.modRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? scan.modRoot;
    const form = await showWizardForm<GalaxySizeForm>(context, {
        title: l10n.t('New Galaxy Size'),
        lead: l10n.t(
            "Name it and say how many systems it holds. The game's standard generator is cloned with that count, and the size is offered when a new career or creative game begins."
        ),
        fieldsHtml: `
<div class="row">
<div class="field">
<label for="id">${escapeHtml(l10n.t('Size id'))}</label>
<input id="id" type="text" autocomplete="off" spellcheck="false" />
<div class="hint">${escapeHtml(l10n.t('One word: letters, digits and underscores. Huge, Tiny, Sprawling.'))}</div>
</div>
<div class="field">
<label for="name">${escapeHtml(l10n.t('Display name'))}</label>
<input id="name" type="text" autocomplete="off" />
</div>
</div>
<div class="field">
<label for="systems">${escapeHtml(l10n.t('Solar systems'))}</label>
<input id="systems" type="number" min="1" max="2000" value="${Math.round(scan.standardSystems * 2)}" />
<div class="hint">${escapeHtml(l10n.t('The standard galaxy holds {0}.', String(scan.standardSystems)))}</div>
</div>`,
        facts: [
            escapeHtml(l10n.t('Written into the mod {0}, under galaxy_map/.', modName)),
            escapeHtml(l10n.t('Its name and its tip are keys in the language files.')),
        ],
        strings: {
            invalidId: l10n.t('One word: letters, digits and underscores, starting with a letter.'),
            takenId: l10n.t('A galaxy size of that id already exists.'),
            emptyName: l10n.t('Give it a name.'),
            badCount: l10n.t('A whole number of systems from 1 up.'),
            taken: scriptJson(scan.takenIds.map((id) => id.toLowerCase())),
        },
        submit: l10n.t('Create galaxy size'),
        script: `
    var taken = JSON.parse(strings.taken);
    var byId = function (id) { return document.getElementById(id); };
    var nameTouched = false;
    byId('id').addEventListener('input', function () {
        if (nameTouched) return;
        byId('name').value = byId('id').value.trim().split('_').filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    });
    byId('name').addEventListener('input', function () { nameTouched = byId('name').value.trim().length > 0; });
    window.wizard = {
        validate: function () {
            var id = byId('id').value.trim();
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) return id ? strings.invalidId : ' ';
            if (taken.indexOf(id.toLowerCase()) >= 0) return strings.takenId;
            if (!byId('name').value.trim()) return strings.emptyName;
            var systems = Number(byId('systems').value);
            if (!(systems >= 1) || systems !== Math.floor(systems)) return strings.badCount;
            return '';
        },
        answer: function () {
            return { id: byId('id').value.trim(), name: byId('name').value.trim(), systems: Number(byId('systems').value) };
        },
    };`,
    });
    if (!form) return;

    const result = await applyForWizard<NewGalaxySizeApplyResult>(
        client,
        NEW_GALAXY_SIZE_SERVER_COMMAND,
        { uri, ...form },
        creationFailureMessage
    );
    if (!result) return;
    const notes = [l10n.t('Cosmoteer: created the galaxy size {0}, offered when a new game begins.', result.id)];
    notes.push(...wiringNotes(result.wiring, result.manifests));
    if (result.localizationFiles.length === 0) {
        notes.push(l10n.t('This mod ships no language file, so its name and tip were not declared anywhere.'));
    }
    const document = await workspace.openTextDocument(Uri.file(result.file));
    await window.showTextDocument(document, { preview: false });
    window.showInformationMessage(notes.join(' '));
}
