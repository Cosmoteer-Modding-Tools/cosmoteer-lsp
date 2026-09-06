import { ExtensionContext, Uri, l10n, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { creationFailureMessage, wiringNotes } from './nebula-wizard';
import { applyForWizard, scanForWizard, wizardAnchor } from './wizard-client';
import { escapeHtml, showWizardForm } from './wizard-form';
import { NewTechApplyResult, NewTechPart, NewTechScanResult, TechForm } from './tech-wizard.types';

/**
 * Creating a tech: a part of the mod, a cost and the techs it builds on. The server writes the tech
 * with the part's own name, description, icon and group read by reference, and adds it to the
 * game's tech tree from the manifest, which is what puts the part behind a purchase at a station.
 */

/** The palette command, distinct from the server's own command id. */
export const NEW_TECH_LOCAL_COMMAND = 'cosmoteer.newTech.create';

/** The server command the wrapper runs. */
const NEW_TECH_SERVER_COMMAND = 'cosmoteer.newTech';

/** The cost the form starts with, the price of a mid-tree vanilla tech. */
const DEFAULT_COST = 3000;

/**
 * Why nothing was created, for the two refusals this wizard has of its own on top of the shared ones.
 *
 * @param failure the server's reason.
 * @returns the message.
 */
const techFailureMessage = (failure: string): string => {
    switch (failure) {
        case 'noParts':
            return l10n.t(
                'Cosmoteer: this mod declares no part, and a tech is written for a part. Create a part first.'
            );
        case 'unknownPart':
            return l10n.t('Cosmoteer: the mod declares no part of that id, so nothing was created.');
        default:
            return creationFailureMessage(failure);
    }
};

/**
 * One line of the part picker: the name when the language files give one, the id otherwise, and
 * the group field the tech will mirror.
 *
 * @param part the part the server reported.
 * @returns the option's text.
 */
const partLabel = (part: NewTechPart): string => {
    const name = part.name ? `${part.name} (${part.id})` : part.id;
    switch (part.groupField) {
        case 'EditorGroups':
            return l10n.t('{0}, in several toolbar groups', name);
        case 'none':
            return l10n.t('{0}, in no toolbar group', name);
        default:
            return name;
    }
};

/**
 * Creates a tech in the mod of the active document.
 *
 * @param context the extension context, for the form.
 * @param client the language client the command runs through.
 * @param anchor the uri the mod is found from, absent to find it from the editor.
 */
export async function createNewTech(context: ExtensionContext, client: LanguageClient, anchor?: string): Promise<void> {
    const uri = wizardAnchor(anchor);
    if (!uri) return;
    const scan = await scanForWizard<NewTechScanResult>(client, NEW_TECH_SERVER_COMMAND, uri, techFailureMessage);
    if (!scan) return;
    const modName = scan.modRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? scan.modRoot;
    const partOptions = scan.parts
        .map((part) => `<option value="${escapeHtml(part.id)}">${escapeHtml(partLabel(part))}</option>`)
        .join('');
    const techRows = scan.techs
        .map((tech) => {
            const text = tech.name ? `${tech.name} (${tech.id})` : tech.id;
            return `<label class="inline tech" data-text="${escapeHtml(text.toLowerCase())}"><input type="checkbox" name="prerequisite" value="${escapeHtml(tech.id)}" />${escapeHtml(text)}</label>`;
        })
        .join('');
    const form = await showWizardForm<TechForm>(context, {
        title: l10n.t('New Tech'),
        lead: l10n.t(
            'Pick the part the tech unlocks, what it costs at a station and the techs a player needs first. Until a tech names it, the part is buildable from the start of a career.'
        ),
        fieldsHtml: `
<div class="field">
<label for="part">${escapeHtml(l10n.t('Part to unlock'))}</label>
<select id="part">${partOptions}</select>
<div class="hint">${escapeHtml(l10n.t('The tech takes its name, description, icon and toolbar group from the part.'))}</div>
</div>
<div class="field">
<label for="cost">${escapeHtml(l10n.t('Cost'))}</label>
<input id="cost" type="number" min="1" step="1" value="${DEFAULT_COST}" />
<div class="hint">${escapeHtml(l10n.t("Before the station's reputation factor. The game's mid-tree techs cost {0}.", String(DEFAULT_COST)))}</div>
</div>
<div class="field">
<label for="filter">${escapeHtml(l10n.t('Prerequisites'))}</label>
<input id="filter" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(l10n.t('Filter the techs'))}" />
<div class="techs" id="techs">${techRows}</div>
<div class="hint" id="picked"></div>
</div>
<style>
.techs { max-height: 14rem; overflow-y: auto; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); padding: 0.3rem 0.5rem; margin-top: 0.3rem; }
.techs label.tech { display: block; padding: 0.1rem 0; }
</style>`,
        facts: [
            escapeHtml(l10n.t('Written into the mod {0}, under techs/.', modName)),
            escapeHtml(l10n.t("Added to the game's tech tree with an action in mod.rules.")),
        ],
        strings: {
            noPart: l10n.t('Pick a part.'),
            badCost: l10n.t('A whole number above zero.'),
            picked: l10n.t('Chosen:'),
            none: l10n.t('none'),
        },
        submit: l10n.t('Create tech'),
        script: `
    var byId = function (id) { return document.getElementById(id); };
    var boxes = Array.prototype.slice.call(document.querySelectorAll('input[name=prerequisite]'));
    var chosen = function () {
        return boxes.filter(function (box) { return box.checked; }).map(function (box) { return box.value; });
    };
    var showChosen = function () {
        var ids = chosen();
        byId('picked').textContent = strings.picked + ' ' + (ids.length ? ids.join(', ') : strings.none);
    };
    byId('filter').addEventListener('input', function () {
        var needle = byId('filter').value.trim().toLowerCase();
        Array.prototype.forEach.call(document.querySelectorAll('label.tech'), function (row) {
            var hit = !needle || row.getAttribute('data-text').indexOf(needle) >= 0;
            var box = row.querySelector('input');
            row.style.display = hit || box.checked ? '' : 'none';
        });
    });
    boxes.forEach(function (box) { box.addEventListener('change', showChosen); });
    showChosen();
    window.wizard = {
        validate: function () {
            if (!byId('part').value) return strings.noPart;
            var cost = Number(byId('cost').value);
            if (!(cost >= 1) || cost !== Math.floor(cost)) return strings.badCost;
            return '';
        },
        answer: function () {
            return { part: byId('part').value, cost: Number(byId('cost').value), prerequisites: chosen() };
        },
    };`,
    });
    if (!form) return;

    const result = await applyForWizard<NewTechApplyResult>(client, NEW_TECH_SERVER_COMMAND, { uri, ...form }, techFailureMessage);
    if (!result) return;
    const notes = [
        l10n.t(
            'Cosmoteer: created the tech {0}. The part is now bought at a station before it can be built.',
            result.id
        ),
    ];
    notes.push(...wiringNotes(result.wiring, result.manifests));
    const document = await workspace.openTextDocument(Uri.file(result.file));
    await window.showTextDocument(document, { preview: false });
    window.showInformationMessage(notes.join(' '));
}
