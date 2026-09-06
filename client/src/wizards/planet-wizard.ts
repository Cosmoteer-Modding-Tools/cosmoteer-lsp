import { ExtensionContext, Uri, l10n, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { creationFailureMessage, wiringNotes } from './nebula-wizard';
import { applyForWizard, scanForWizard, wizardAnchor } from './wizard-client';
import { escapeHtml, scriptJson, showWizardForm } from './wizard-form';
import { NewPlanetApplyResult, NewPlanetScanResult, PlanetBase, PlanetForm } from './planet-wizard.types';

/**
 * Creating a planet: a doodad built on one of the game's own planets, drawn in that planet's style,
 * with a name, a size of the author's and a say in where the career sectors place it. The server
 * writes the doodad and its key, and wires it into the doodad registry and the sector spawner from
 * the manifest.
 */

/** The palette command, distinct from the server's own command id. */
export const NEW_PLANET_LOCAL_COMMAND = 'cosmoteer.newPlanet.create';

/** The server command the wrapper runs. */
const NEW_PLANET_SERVER_COMMAND = 'cosmoteer.newPlanet';

/**
 * Why nothing was created, for the failures this wizard adds to the shared ones.
 *
 * @param failure the server's reason.
 * @returns the message.
 */
const planetFailureMessage = (failure: string): string =>
    failure === 'noAuthorPrefix'
        ? l10n.t(
              "Cosmoteer: a planet id opens with the author segment of the mod id, and this mod's id has none. Give the mod an id like author.mod first."
          )
        : creationFailureMessage(failure);

/**
 * Creates a planet in the mod of the active document.
 *
 * @param context the extension context, for the form.
 * @param client the language client the command runs through.
 * @param anchor the uri the mod is found from, absent to find it from the editor.
 */
export async function createNewPlanet(
    context: ExtensionContext,
    client: LanguageClient,
    anchor?: string
): Promise<void> {
    const uri = wizardAnchor(anchor);
    if (!uri) return;
    const scan = await scanForWizard<NewPlanetScanResult>(client, NEW_PLANET_SERVER_COMMAND, uri, planetFailureMessage);
    if (!scan) return;
    if (scan.bases.length === 0) {
        window.showWarningMessage(
            l10n.t("Cosmoteer: the game's planets could not be read, so there is no look to start from.")
        );
        return;
    }
    if (!scan.authorPrefix) {
        window.showWarningMessage(planetFailureMessage('noAuthorPrefix'));
        return;
    }
    const form = await showPlanetForm(context, scan);
    if (!form) return;

    const result = await applyForWizard<NewPlanetApplyResult>(client, NEW_PLANET_SERVER_COMMAND, { uri, ...form }, planetFailureMessage);
    if (!result) return;
    const notes = [
        result.wiring.spawner === 'skipped'
            ? l10n.t('Cosmoteer: created the planet {0}, offered in the creative palette.', result.id)
            : l10n.t('Cosmoteer: created the planet {0}, spawning in career sectors from now on.', result.id),
    ];
    notes.push(...wiringNotes(result.wiring, result.manifests));
    if (result.localizationFiles.length === 0) {
        notes.push(l10n.t('This mod ships no language file, so its name was not declared anywhere.'));
    } else {
        notes.push(l10n.t('Its name is declared in the language files under {0}.', result.localizationKeys.join(', ')));
    }
    const document = await workspace.openTextDocument(Uri.file(result.file));
    await window.showTextDocument(document, { preview: false });
    window.showInformationMessage(notes.join(' '));
}

/** The placements the form offers, in the server's words and the author's. */
const placementLabels = (): [string, string, string][] => [
    ['inner', l10n.t('Inner planet'), l10n.t('Close to the sun, among the rocky worlds.')],
    ['outer', l10n.t('Outer planet'), l10n.t('Far out, among the gas giants.')],
    ['innerMoon', l10n.t('Moon of an inner planet'), l10n.t('Small, orbiting an inner planet.')],
    ['outerMoon', l10n.t('Moon of an outer planet'), l10n.t('Orbiting a gas giant.')],
    ['none', l10n.t('Not in career sectors'), l10n.t('Only placed by hand from the creative palette.')],
];

/**
 * The form: id, name, the base planet, where it spawns and how often, and the optional sizes.
 *
 * @param context the extension context.
 * @param scan the server's report.
 * @returns the answers, or undefined when the form was closed.
 */
const showPlanetForm = (context: ExtensionContext, scan: NewPlanetScanResult): Promise<PlanetForm | undefined> => {
    const modName = scan.modRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? scan.modRoot;
    const offered = placementLabels().filter(([id]) => scan.placements.includes(id));
    const baseOption = (base: PlanetBase): string => {
        const text = base.label
            ? l10n.t('{0} ({1} style, {2})', base.label, base.style, base.id)
            : l10n.t('{0} style ({1})', base.style, base.id);
        return `<option value="${escapeHtml(base.id)}">${escapeHtml(text)}</option>`;
    };
    const fieldsHtml = `
<div class="row">
<div class="field">
<label for="id">${escapeHtml(l10n.t('Planet id'))}</label>
<input id="id" type="text" autocomplete="off" spellcheck="false" />
<div class="hint" id="idHint">${escapeHtml(l10n.t('One word: letters, digits and underscores. The doodad id becomes {0}.planet_<word>.', scan.authorPrefix))}</div>
</div>
<div class="field">
<label for="name">${escapeHtml(l10n.t('Display name'))}</label>
<input id="name" type="text" autocomplete="off" />
<div class="hint">${escapeHtml(l10n.t('The name in the palette and on the map, written to every language file.'))}</div>
</div>
</div>
<div class="field">
<label for="base">${escapeHtml(l10n.t('Built on'))}</label>
<select id="base">
${scan.bases.map(baseOption).join('')}
</select>
<div class="hint">${escapeHtml(l10n.t("One of the game's own planets, inherited whole: its style, its sizes and its orbits. The icon is its own until you draw one."))}</div>
</div>
<div class="field">
<label>${escapeHtml(l10n.t('Where it spawns'))}</label>
${offered
    .map(
        ([id, label, hint], index) =>
            `<label class="inline"><input type="radio" name="placement" value="${escapeHtml(id)}"${index === 0 ? ' checked' : ''} /> ${escapeHtml(label)}</label> <span class="hint">${escapeHtml(hint)}</span><br />`
    )
    .join('')}
</div>
<div class="field">
<label for="weight">${escapeHtml(l10n.t('Chance weight'))}</label>
<input id="weight" type="number" min="0.05" max="100" step="0.05" value="1" />
<div class="hint">${escapeHtml(l10n.t("Against the game's own planets of that list, each of which weighs 1."))}</div>
</div>
<div class="field">
<label class="inline"><input id="resize" type="checkbox" /> ${escapeHtml(l10n.t('Give it a size of its own'))}</label>
</div>
<div class="row" id="sizes" hidden>
<div class="field">
<label for="scaleMin">${escapeHtml(l10n.t('Smallest'))}</label>
<input id="scaleMin" type="number" min="1" max="100000" value="250" />
</div>
<div class="field">
<label for="scaleMax">${escapeHtml(l10n.t('Largest'))}</label>
<input id="scaleMax" type="number" min="1" max="100000" value="1500" />
</div>
<div class="field">
<label for="scaleDefault">${escapeHtml(l10n.t('Placed by hand at'))}</label>
<input id="scaleDefault" type="number" min="1" max="100000" value="1000" />
<div class="hint">${escapeHtml(l10n.t("In world units. The game's rocky worlds span 250 to 1500, its gas giants 1000 to 3000."))}</div>
</div>
</div>`;
    return showWizardForm<PlanetForm>(context, {
        title: l10n.t('New Planet'),
        lead: l10n.t(
            'Pick a planet to build on, name it and say where it spawns. The doodad, its name key and the manifest actions are written for you.'
        ),
        fieldsHtml,
        facts: [
            escapeHtml(l10n.t('Written into the mod {0}, under doodads/planets/.', modName)),
            escapeHtml(l10n.t('Its name is a key in the language files, ready to translate.')),
        ],
        strings: {
            invalidId: l10n.t('One word: letters, digits and underscores, starting with a letter.'),
            takenId: l10n.t('A doodad of that id already exists.'),
            emptyName: l10n.t('Give it a name.'),
            badSizes: l10n.t(
                'The smallest size must not exceed the largest, and the hand-placed size must lie between them.'
            ),
            prefix: scan.authorPrefix,
            taken: scriptJson(scan.takenIds.map((id) => id.toLowerCase())),
        },
        submit: l10n.t('Create planet'),
        script: `
    var taken = JSON.parse(strings.taken);
    var byId = function (id) { return document.getElementById(id); };
    var nameTouched = false;
    var doodadId = function () { return (strings.prefix + '.planet_' + byId('id').value.trim().toLowerCase()); };
    byId('id').addEventListener('input', function () {
        if (nameTouched) return;
        byId('name').value = byId('id').value.trim().split('_').filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    });
    byId('name').addEventListener('input', function () { nameTouched = byId('name').value.trim().length > 0; });
    byId('resize').addEventListener('change', function () { byId('sizes').hidden = !byId('resize').checked; });
    var placement = function () {
        var picked = form.querySelector('input[name=placement]:checked');
        return picked ? picked.value : 'inner';
    };
    window.wizard = {
        validate: function () {
            var id = byId('id').value.trim();
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) return id ? strings.invalidId : ' ';
            if (taken.indexOf(doodadId()) >= 0) return strings.takenId;
            if (!byId('name').value.trim()) return strings.emptyName;
            if (byId('resize').checked) {
                var lo = Number(byId('scaleMin').value), hi = Number(byId('scaleMax').value), at = Number(byId('scaleDefault').value);
                if (!(lo > 0) || !(hi >= lo) || !(at >= lo && at <= hi)) return strings.badSizes;
            }
            return '';
        },
        answer: function () {
            var answer = {
                id: byId('id').value.trim(),
                name: byId('name').value.trim(),
                base: byId('base').value,
                placement: placement(),
                weight: Math.max(0.05, Number(byId('weight').value) || 1),
            };
            if (byId('resize').checked) {
                answer.scale = [Number(byId('scaleMin').value), Number(byId('scaleMax').value)];
                answer.defaultScale = Number(byId('scaleDefault').value);
            }
            return answer;
        },
    };`,
    });
};
