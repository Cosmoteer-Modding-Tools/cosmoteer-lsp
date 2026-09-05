import { ExtensionContext, Uri, l10n, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { creationFailureMessage, wiringNotes } from './nebula-wizard';
import { applyForWizard, scanForWizard, wizardAnchor } from './wizard-client';
import { escapeHtml, scriptJson, showWizardForm } from './wizard-form';
import { TradeGoodApplyResult, TradeGoodForm, TradeGoodScanResult, TradeResource } from './trade-good-wizard.types';

/**
 * Putting a resource into the career trade: the server writes the two manifest actions that make
 * trade ships carry it and stations stock it, with figures on the scale the game's own goods use.
 * Nothing is created in the mod tree.
 */

/** The palette command, distinct from the server's own command id. */
export const TRADE_GOOD_LOCAL_COMMAND = 'cosmoteer.tradeGood.create';

/** The server command the wrapper runs. */
const TRADE_GOOD_SERVER_COMMAND = 'cosmoteer.tradeGood';

/**
 * Why nothing was written, for the failures this wizard adds to the shared ones.
 *
 * @param failure the server's reason.
 * @returns the message.
 */
const tradeFailureMessage = (failure: string): string => {
    switch (failure) {
        case 'unknownResource':
            return l10n.t('Cosmoteer: no resource of that id is declared, so the trade cannot carry it.');
        case 'notStackable':
            return l10n.t(
                'Cosmoteer: that resource has no stack size, and the trade never carries one that does not stack.'
            );
        default:
            return creationFailureMessage(failure);
    }
};

/**
 * Puts a resource into the trade from the mod of the active document.
 *
 * @param context the extension context, for the form.
 * @param client the language client the command runs through.
 * @param anchor the uri the mod is found from, absent to find it from the editor.
 */
export async function createTradeGood(
    context: ExtensionContext,
    client: LanguageClient,
    anchor?: string
): Promise<void> {
    const uri = wizardAnchor(anchor);
    if (!uri) return;
    const scan = await scanForWizard<TradeGoodScanResult>(
        client,
        TRADE_GOOD_SERVER_COMMAND,
        uri,
        tradeFailureMessage,
        l10n.t('Cosmoteer: the mod could not be read, so nothing was written.')
    );
    if (!scan) return;
    const offered = scan.resources.filter((resource) => resource.stackable);
    if (offered.length === 0) {
        window.showWarningMessage(
            l10n.t('Cosmoteer: no resource that stacks is declared anywhere, so there is nothing to trade.')
        );
        return;
    }
    const form = await showTradeGoodForm(context, scan, offered);
    if (!form) return;

    const result = await applyForWizard<TradeGoodApplyResult>(
        client,
        TRADE_GOOD_SERVER_COMMAND,
        { uri, ...form },
        tradeFailureMessage,
        l10n.t('Cosmoteer: nothing was written.')
    );
    if (!result) return;
    const notes = [
        form.stationsBuy
            ? l10n.t('Cosmoteer: trade ships now carry {0}, and stations buy it.', result.resource)
            : l10n.t('Cosmoteer: trade ships now carry {0}, and stations stock it.', result.resource),
    ];
    if (result.wiring.cargo === 'present' && result.wiring.stations === 'present') {
        notes.push(l10n.t('The manifest already traded it, so nothing changed.'));
    }
    notes.push(...wiringNotes(result.wiring, result.manifests));
    if (result.manifest) {
        const document = await workspace.openTextDocument(Uri.file(result.manifest));
        await window.showTextDocument(document, { preview: false });
    }
    window.showInformationMessage(notes.join(' '));
}

/**
 * The form: the resource, how common it is, and whether stations buy it rather than stock it.
 *
 * @param context the extension context.
 * @param scan the server's report.
 * @param offered the resources that stack, which are the ones the trade can carry.
 * @returns the answers, or undefined when the form was closed.
 */
const showTradeGoodForm = (
    context: ExtensionContext,
    scan: TradeGoodScanResult,
    offered: TradeResource[]
): Promise<TradeGoodForm | undefined> => {
    const modName = scan.modRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? scan.modRoot;
    const option = (resource: TradeResource): string => {
        const source = resource.source === 'mod' ? l10n.t('mod') : l10n.t('game');
        const traded =
            resource.alreadyCarried && resource.alreadyStocked
                ? l10n.t(', already traded')
                : resource.alreadyCarried
                  ? l10n.t(', already carried')
                  : resource.alreadyStocked
                    ? l10n.t(', already stocked')
                    : '';
        const text = resource.name
            ? `${resource.name} (${resource.id}, ${source}${traded})`
            : `${resource.id} (${source}${traded})`;
        return `<option value="${escapeHtml(resource.id)}">${escapeHtml(text)}</option>`;
    };
    const rarities: [string, string, string][] = [
        [
            'common',
            l10n.t('Common'),
            l10n.t('Weight 20, as iron and coils. Stations keep up to a tenth of their storage in it.'),
        ],
        ['uncommon', l10n.t('Uncommon'), l10n.t('Weight 10, as hyperium and copper. Stations keep up to a twentieth.')],
        ['rare', l10n.t('Rare'), l10n.t('Weight 5 and half a hold, as diamonds and gold. Stations keep only a trace.')],
    ];
    const fieldsHtml = `
<div class="field">
<label for="resource">${escapeHtml(l10n.t('Resource'))}</label>
<select id="resource">
${offered.map(option).join('')}
</select>
<div class="hint">${escapeHtml(l10n.t("Your mod's resources first, then the game's own. A game resource the game does not trade can be made tradeable here."))}</div>
</div>
<div class="field">
<label>${escapeHtml(l10n.t('How common it is'))}</label>
${rarities
    .map(
        ([id, label, hint], index) =>
            `<label class="inline"><input type="radio" name="rarity" value="${escapeHtml(id)}"${index === 1 ? ' checked' : ''} /> ${escapeHtml(label)}</label> <span class="hint">${escapeHtml(hint)}</span><br />`
    )
    .join('')}
</div>
<div class="field">
<label class="inline"><input id="stationsBuy" type="checkbox" /> ${escapeHtml(l10n.t('Stations buy it rather than sell it'))}</label>
<div class="hint">${escapeHtml(l10n.t('Stations then hold none of their own and pay for what you bring, the way the game treats precious goods.'))}</div>
</div>`;
    return showWizardForm<TradeGoodForm>(context, {
        title: l10n.t('Resource in Trade'),
        lead: l10n.t(
            'Pick a resource and say how common it is. Two manifest actions put it on every trade ship and in every station.'
        ),
        fieldsHtml,
        facts: [
            escapeHtml(l10n.t('Written into the manifest of the mod {0}. No file is created.', modName)),
            escapeHtml(l10n.t('The resource needs a buy price to be worth anything at a station.')),
        ],
        strings: {
            resources: scriptJson(offered),
        },
        submit: l10n.t('Put it in the trade'),
        script: `
    var byId = function (id) { return document.getElementById(id); };
    var rarity = function () {
        var picked = form.querySelector('input[name=rarity]:checked');
        return picked ? picked.value : 'uncommon';
    };
    window.wizard = {
        validate: function () { return byId('resource').value ? '' : ' '; },
        answer: function () {
            return { resource: byId('resource').value, rarity: rarity(), stationsBuy: byId('stationsBuy').checked };
        },
    };`,
    });
};
