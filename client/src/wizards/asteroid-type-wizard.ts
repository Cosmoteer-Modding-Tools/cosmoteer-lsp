import { ExtensionContext, Uri, l10n, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { creationFailureMessage, wiringNotes } from './nebula-wizard';
import { applyForWizard, scanForWizard, wizardAnchor } from './wizard-client';
import { escapeHtml, scriptJson, showWizardForm } from './wizard-form';
import {
    AsteroidResource,
    AsteroidSize,
    AsteroidTypeForm,
    NewAsteroidTypeApplyResult,
    NewAsteroidTypeScanResult,
} from './asteroid-type-wizard.types';

/**
 * Creating an asteroid type: a resource the deposits yield, a look borrowed from one of the game's
 * own deposits, and a say in how rare and how big it is. The server writes the deposit tiles, the
 * recipes, the spawner entries and the texts, and wires each in from the manifest.
 */

/** The palette command, distinct from the server's own command id. */
export const NEW_ASTEROID_TYPE_LOCAL_COMMAND = 'cosmoteer.newAsteroidType.create';

/** The server command the wrapper runs. */
const NEW_ASTEROID_TYPE_SERVER_COMMAND = 'cosmoteer.newAsteroidType';

/** The sizes in the game's order, each with its caption. */
const SIZES: readonly { id: AsteroidSize; caption: string }[] = [
    { id: 's', caption: 'S' },
    { id: 'm', caption: 'M' },
    { id: 'l', caption: 'L' },
    { id: 'xl', caption: 'XL' },
    { id: 'xxl', caption: 'XXL' },
];

/**
 * Creates an asteroid type in the mod of the active document.
 *
 * @param context the extension context, for the form.
 * @param client the language client the command runs through.
 * @param anchor the uri the mod is found from, absent to find it from the editor.
 */
export async function createNewAsteroidType(
    context: ExtensionContext,
    client: LanguageClient,
    anchor?: string
): Promise<void> {
    const uri = wizardAnchor(anchor);
    if (!uri) return;
    const scan = await scanForWizard<NewAsteroidTypeScanResult>(
        client,
        NEW_ASTEROID_TYPE_SERVER_COMMAND,
        uri,
        failureMessage
    );
    if (!scan) return;
    if (scan.resources.length === 0 || scan.looks.length === 0) {
        window.showWarningMessage(
            l10n.t(
                "Cosmoteer: the game's resources and asteroid deposits could not be read, so there is nothing to build on."
            )
        );
        return;
    }
    if (!scan.authorPrefix) {
        window.showWarningMessage(failureMessage('noAuthorPrefix'));
        return;
    }
    const form = await showAsteroidTypeForm(context, scan);
    if (!form) return;

    const result = await applyForWizard<NewAsteroidTypeApplyResult>(
        client,
        NEW_ASTEROID_TYPE_SERVER_COMMAND,
        { uri, ...form },
        failureMessage
    );
    if (!result) return;
    const notes = [
        l10n.t('Cosmoteer: created the asteroid type {0}, spawning in career sectors from now on.', result.id),
    ];
    // The shared notes read `present` for a wiring that was already there, which this command
    // reports as `alreadyThere`, so the outcomes are mapped rather than the notes duplicated.
    const outcomes = Object.fromEntries(
        Object.entries(result.wiring).map(([key, outcome]) => [key, outcome === 'alreadyThere' ? 'present' : outcome])
    );
    notes.push(...wiringNotes(outcomes, result.manifests));
    if (result.localizationFiles.length === 0) {
        notes.push(
            l10n.t(
                'This mod ships no language file, so the names of its asteroids and deposits were not declared anywhere.'
            )
        );
    } else {
        notes.push(
            l10n.t('Its names are placeholders in the language files: {0}.', result.localizationKeys.join(', '))
        );
    }
    const recipe = result.files.find((file) => file.includes('doodad_asteroid_')) ?? result.files[0];
    if (recipe) {
        const document = await workspace.openTextDocument(Uri.file(recipe));
        await window.showTextDocument(document, { preview: false });
    }
    window.showInformationMessage(notes.join(' '));
}

/**
 * Why nothing was created: the failures every creation wizard shares, plus the one only an asteroid
 * type can meet.
 *
 * @param failure the server's reason.
 * @returns the message.
 */
const failureMessage = (failure: string): string =>
    failure === 'noAuthorPrefix'
        ? l10n.t(
              "Cosmoteer: the manifest's ID has no author prefix (author.mod_name), which every asteroid and deposit id is built from."
          )
        : creationFailureMessage(failure);

/**
 * The form: id, name, the resource, the look, the rarity, the sizes, the weight, the hard tiles and
 * the density.
 *
 * @param context the extension context.
 * @param scan the server's report.
 * @returns the answers, or undefined when the form was closed.
 */
const showAsteroidTypeForm = (
    context: ExtensionContext,
    scan: NewAsteroidTypeScanResult
): Promise<AsteroidTypeForm | undefined> => {
    const modName = scan.modRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? scan.modRoot;
    const resourceCaption = (resource: AsteroidResource): string =>
        resource.name ? `${resource.name} (${resource.id})` : resource.id;
    const fieldsHtml = `
<div class="row">
<div class="field">
<label for="id">${escapeHtml(l10n.t('Asteroid type id'))}</label>
<input id="id" type="text" autocomplete="off" spellcheck="false" />
<div class="hint">${escapeHtml(l10n.t('One word: letters, digits and underscores. Every asteroid and deposit id is built around it, as {0}.asteroid_<id>_s.', scan.authorPrefix))}</div>
</div>
<div class="field">
<label for="name">${escapeHtml(l10n.t('Display name'))}</label>
<input id="name" type="text" autocomplete="off" />
<div class="hint">${escapeHtml(l10n.t('The name of its asteroids and deposits, written to every language file.'))}</div>
</div>
</div>
<div class="row">
<div class="field">
<label for="resource">${escapeHtml(l10n.t('Resource'))}</label>
<select id="resource">
${scan.resources.map((resource) => `<option value="${escapeHtml(resource.id)}">${escapeHtml(resourceCaption(resource))}</option>`).join('')}
</select>
<div class="hint">${escapeHtml(l10n.t('What mining a deposit yields.'))}</div>
</div>
<div class="field">
<label for="look">${escapeHtml(l10n.t('Look'))}</label>
<select id="look">
${scan.looks.map((look) => `<option value="${escapeHtml(look.id)}">${escapeHtml(look.label)}</option>`).join('')}
</select>
<div class="hint">${escapeHtml(l10n.t("One of the game's own deposits, whose textures and palette icons are borrowed until you draw your own."))}</div>
</div>
</div>
<div class="field">
<label>${escapeHtml(l10n.t('Rarity'))}</label>
<label class="inline"><input type="radio" name="rarity" value="common" checked /> ${escapeHtml(l10n.t('Common, in the belts and fields like iron'))}</label><br />
<label class="inline"><input type="radio" name="rarity" value="rare" /> ${escapeHtml(l10n.t('Rare, a valuable find marked on the map like uranium'))}</label><br />
<label class="inline"><input type="radio" name="rarity" value="sun" /> ${escapeHtml(l10n.t('Sun, inside the damage zone of a sun'))}</label>
</div>
<div class="field">
<label>${escapeHtml(l10n.t('Sizes'))}</label>
${SIZES.map((size) => `<label class="inline"><input type="checkbox" class="size" value="${size.id}" checked /> ${escapeHtml(size.caption)}</label> `).join('')}
<div class="hint">${escapeHtml(l10n.t('One recipe per size. The rare and sun lists only place the large sizes.'))}</div>
</div>
<div class="row">
<div class="field">
<label for="weight">${escapeHtml(l10n.t('Weight'))}</label>
<input id="weight" type="number" min="0.001" step="any" value="1" />
<div class="hint">${escapeHtml(l10n.t("A factor on the game's own spawn weights, relative rather than a percentage. 1 is as often as iron."))}</div>
</div>
<div class="field">
<label for="density">${escapeHtml(l10n.t('Deposit density'))}</label>
<input id="density" type="number" min="0.001" step="any" placeholder="${escapeHtml(l10n.t("the resource's own"))}" />
<div class="hint">${escapeHtml(l10n.t('How much of an asteroid is deposit. Leave it empty to follow the resource, 1 is as dense as iron.'))}</div>
</div>
</div>
<div class="field">
<label class="inline"><input id="hard" type="checkbox" checked /> ${escapeHtml(l10n.t('Hard tiles towards the middle, needing a mining laser'))}</label>
</div>`;
    return showWizardForm<AsteroidTypeForm>(context, {
        title: l10n.t('New Asteroid Type'),
        lead: l10n.t(
            'Pick a resource and a look and say how rare it is. The deposit tiles, the asteroid recipes, the spawner entries and the manifest actions are written for you.'
        ),
        fieldsHtml,
        facts: [
            escapeHtml(l10n.t('Written into the mod {0}, under asteroids/.', modName)),
            escapeHtml(
                l10n.t(
                    'The names of its asteroids and deposits are keys in the language files, with a placeholder to rewrite.'
                )
            ),
        ],
        strings: {
            invalidId: l10n.t('One word: letters, digits and underscores, starting with a letter.'),
            takenId: l10n.t('An asteroid type of that id already exists.'),
            emptyName: l10n.t('Give it a name.'),
            noSizes: l10n.t('Pick at least one size.'),
            badWeight: l10n.t('The weight must be a number above zero.'),
            badDensity: l10n.t('The density must be a number above zero, or empty.'),
            looks: scriptJson(scan.looks.map((look) => look.id.toLowerCase())),
            taken: scriptJson(scan.takenIds.map((id) => id.toLowerCase())),
        },
        submit: l10n.t('Create asteroid type'),
        script: `
    var looks = JSON.parse(strings.looks);
    var taken = JSON.parse(strings.taken);
    var byId = function (id) { return document.getElementById(id); };
    var sizeBoxes = Array.prototype.slice.call(document.querySelectorAll('input.size'));
    var nameTouched = false;
    var lookTouched = false;
    var sizesTouched = false;
    var rarity = function () { return document.querySelector('input[name=rarity]:checked').value; };
    byId('id').addEventListener('input', function () {
        if (nameTouched) return;
        byId('name').value = byId('id').value.trim().split('_').filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    });
    byId('name').addEventListener('input', function () { nameTouched = byId('name').value.trim().length > 0; });
    byId('look').addEventListener('change', function () { lookTouched = true; });
    byId('resource').addEventListener('change', function () {
        if (lookTouched) return;
        var wanted = byId('resource').value.toLowerCase();
        if (looks.indexOf(wanted) >= 0) byId('look').value = byId('resource').value;
    });
    sizeBoxes.forEach(function (box) { box.addEventListener('change', function () { sizesTouched = true; }); });
    Array.prototype.forEach.call(document.querySelectorAll('input[name=rarity]'), function (radio) {
        radio.addEventListener('change', function () {
            if (sizesTouched) return;
            var large = rarity() !== 'common';
            sizeBoxes.forEach(function (box) { box.checked = !large || box.value === 'l' || box.value === 'xl' || box.value === 'xxl'; });
        });
    });
    var sizes = function () { return sizeBoxes.filter(function (box) { return box.checked; }).map(function (box) { return box.value; }); };
    window.wizard = {
        validate: function () {
            var id = byId('id').value.trim();
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) return id ? strings.invalidId : ' ';
            if (taken.indexOf(id.toLowerCase()) >= 0) return strings.takenId;
            if (!byId('name').value.trim()) return strings.emptyName;
            if (sizes().length === 0) return strings.noSizes;
            if (!(Number(byId('weight').value) > 0)) return strings.badWeight;
            var density = byId('density').value.trim();
            if (density && !(Number(density) > 0)) return strings.badDensity;
            return '';
        },
        answer: function () {
            var density = byId('density').value.trim();
            var answer = {
                id: byId('id').value.trim(),
                name: byId('name').value.trim(),
                resource: byId('resource').value,
                look: byId('look').value,
                rarity: rarity(),
                sizes: sizes(),
                weight: Number(byId('weight').value),
                hard: byId('hard').checked,
            };
            if (density) answer.density = Number(density);
            return answer;
        },
    };`,
    });
};
