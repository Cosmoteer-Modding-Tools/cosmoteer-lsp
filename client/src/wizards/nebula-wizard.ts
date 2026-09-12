import { ExtensionContext, Uri, l10n, window, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { applyForWizard, scanForWizard, wizardAnchor } from './wizard-client';
import { escapeHtml, scriptJson, showWizardForm } from './wizard-form';
import { NebulaForm, NewNebulaApplyResult, NewNebulaScanResult, Rgb } from './nebula-wizard.types';

/**
 * Creating a nebula: a look inherited from one of the game's own, three colours of the author's, and
 * a say in where it spawns. The server writes the nebula, its spawner entry, its creative-mode
 * doodad and its texts, and wires each in from the manifest.
 */

/** The palette command, distinct from the server's own command id. */
export const NEW_NEBULA_LOCAL_COMMAND = 'cosmoteer.newNebula.create';

/** The server command the wrapper runs. */
const NEW_NEBULA_SERVER_COMMAND = 'cosmoteer.newNebula';

/**
 * Creates a nebula in the mod of the active document.
 *
 * @param context the extension context, for the form.
 * @param client the language client the command runs through.
 * @param anchor the uri the mod is found from, absent to find it from the editor.
 */
export async function createNewNebula(
    context: ExtensionContext,
    client: LanguageClient,
    anchor?: string
): Promise<void> {
    const uri = wizardAnchor(anchor);
    if (!uri) return;
    const scan = await scanForWizard<NewNebulaScanResult>(
        client,
        NEW_NEBULA_SERVER_COMMAND,
        uri,
        creationFailureMessage
    );
    if (!scan) return;
    if (scan.bases.length === 0) {
        window.showWarningMessage(
            l10n.t("Cosmoteer: the game's nebulas could not be read, so there is no look to start from.")
        );
        return;
    }
    const form = await showNebulaForm(context, scan);
    if (!form) return;

    const result = await applyForWizard<NewNebulaApplyResult>(
        client,
        NEW_NEBULA_SERVER_COMMAND,
        { uri, ...form },
        creationFailureMessage
    );
    if (!result) return;
    const notes = [l10n.t('Cosmoteer: created the nebula {0}, spawning in career sectors from now on.', result.id)];
    notes.push(...wiringNotes(result.wiring, result.manifests));
    if (result.localizationFiles.length === 0) {
        notes.push(l10n.t('This mod ships no language file, so its tooltip and HUD text were not declared anywhere.'));
    } else {
        notes.push(
            l10n.t('Its tooltip is a placeholder in the language files: {0}.', result.localizationKeys.join(', '))
        );
    }
    const document = await workspace.openTextDocument(Uri.file(result.nebulaFile));
    await window.showTextDocument(document, { preview: false });
    window.showInformationMessage(notes.join(' '));
}

/**
 * The form: id, name, the base look, three colours, and the spawn settings.
 *
 * @param context the extension context.
 * @param scan the server's report.
 * @returns the answers, or undefined when the form was closed.
 */
const showNebulaForm = (context: ExtensionContext, scan: NewNebulaScanResult): Promise<NebulaForm | undefined> => {
    const modName = scan.modRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? scan.modRoot;
    const hex = (rgb: Rgb): string =>
        `#${rgb.map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')).join('')}`;
    const first = scan.bases[0];
    const fieldsHtml = `
<div class="row">
<div class="field">
<label for="id">${escapeHtml(l10n.t('Nebula id'))}</label>
<input id="id" type="text" autocomplete="off" spellcheck="false" />
<div class="hint">${escapeHtml(l10n.t('How the spawner and the doodad name it. One word: letters, digits and underscores.'))}</div>
</div>
<div class="field">
<label for="name">${escapeHtml(l10n.t('Display name'))}</label>
<input id="name" type="text" autocomplete="off" />
<div class="hint">${escapeHtml(l10n.t('The name in its tooltip and on the HUD, written to every language file.'))}</div>
</div>
</div>
<div class="field">
<label for="base">${escapeHtml(l10n.t('Look and behaviour'))}</label>
<select id="base">
${scan.bases.map((base) => `<option value="${escapeHtml(base.id)}">${escapeHtml(base.id)}</option>`).join('')}
</select>
<div class="hint">${escapeHtml(l10n.t("One of the game's own nebulas, inherited whole: its shaders, its effects on ships and its sounds. The colours below replace its own."))}</div>
</div>
<div class="row">
<div class="field"><label for="color1">${escapeHtml(l10n.t('Colour 1'))}</label><input id="color1" type="color" value="${hex(first.colors[0])}" /></div>
<div class="field"><label for="color2">${escapeHtml(l10n.t('Colour 2'))}</label><input id="color2" type="color" value="${hex(first.colors[1])}" /></div>
<div class="field"><label for="color3">${escapeHtml(l10n.t('Colour 3'))}</label><input id="color3" type="color" value="${hex(first.colors[2])}" /></div>
</div>
<div class="row">
<div class="field">
<label for="radius">${escapeHtml(l10n.t('Radius'))}</label>
<input id="radius" type="number" min="1000" max="1000000" step="1000" value="100000" />
<div class="hint">${escapeHtml(l10n.t("In world units. The game's clouds span 25000 to 100000."))}</div>
</div>
<div class="field">
<label for="countMax">${escapeHtml(l10n.t('At most per sector'))}</label>
<input id="countMax" type="number" min="1" max="20" value="2" />
<div class="hint">${escapeHtml(l10n.t('A sector rolls between none and this many.'))}</div>
</div>
<div class="field">
<label for="chance">${escapeHtml(l10n.t('Chance per sector'))}</label>
<input id="chance" type="number" min="1" max="100" value="100" />
<div class="hint">${escapeHtml(l10n.t('In percent.'))}</div>
</div>
</div>
<div class="row">
<div class="field">
<label for="distanceMin">${escapeHtml(l10n.t('Nearest to the centre'))}</label>
<input id="distanceMin" type="number" min="0" max="1000000" step="1000" value="10000" />
</div>
<div class="field">
<label for="distanceMax">${escapeHtml(l10n.t('Farthest from the centre'))}</label>
<input id="distanceMax" type="number" min="0" max="1000000" step="1000" value="25000" />
</div>
</div>
<div class="field">
<label class="inline"><input id="avoidStart" type="checkbox" checked /> ${escapeHtml(l10n.t('Keep it out of the starting sector'))}</label>
</div>`;
    return showWizardForm<NebulaForm>(context, {
        title: l10n.t('New Nebula'),
        lead: l10n.t(
            'Pick a look, give it your colours and say where it spawns. The files, the doodad for creative mode and the manifest actions are written for you.'
        ),
        fieldsHtml,
        facts: [
            escapeHtml(l10n.t('Written into the mod {0}, under nebulas/.', modName)),
            escapeHtml(
                l10n.t('Its tooltip and HUD text are keys in the language files, with a placeholder to rewrite.')
            ),
        ],
        strings: {
            invalidId: l10n.t('One word: letters, digits and underscores, starting with a letter.'),
            takenId: l10n.t('A nebula of that id already exists.'),
            emptyName: l10n.t('Give it a name.'),
            badRange: l10n.t('The nearest distance must not exceed the farthest.'),
            bases: scriptJson(scan.bases),
            taken: scriptJson(scan.takenIds.map((id) => id.toLowerCase())),
        },
        submit: l10n.t('Create nebula'),
        script: `
    var bases = JSON.parse(strings.bases);
    var taken = JSON.parse(strings.taken);
    var byId = function (id) { return document.getElementById(id); };
    var nameTouched = false;
    var hex = function (rgb) { return '#' + rgb.map(function (c) { return ('0' + Math.max(0, Math.min(255, c)).toString(16)).slice(-2); }).join(''); };
    var rgb = function (value) { return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)]; };
    byId('id').addEventListener('input', function () {
        if (nameTouched) return;
        byId('name').value = byId('id').value.trim().split('_').filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    });
    byId('name').addEventListener('input', function () { nameTouched = byId('name').value.trim().length > 0; });
    byId('base').addEventListener('change', function () {
        var base = bases.filter(function (b) { return b.id === byId('base').value; })[0];
        if (!base) return;
        byId('color1').value = hex(base.colors[0]);
        byId('color2').value = hex(base.colors[1]);
        byId('color3').value = hex(base.colors[2]);
    });
    window.wizard = {
        validate: function () {
            var id = byId('id').value.trim();
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id)) return id ? strings.invalidId : ' ';
            if (taken.indexOf(id.toLowerCase()) >= 0) return strings.takenId;
            if (!byId('name').value.trim()) return strings.emptyName;
            if (Number(byId('distanceMin').value) > Number(byId('distanceMax').value)) return strings.badRange;
            return '';
        },
        answer: function () {
            return {
                id: byId('id').value.trim(),
                name: byId('name').value.trim(),
                base: byId('base').value,
                colors: [rgb(byId('color1').value), rgb(byId('color2').value), rgb(byId('color3').value)],
                radius: Number(byId('radius').value) || 100000,
                count: [0, Math.max(1, Number(byId('countMax').value) || 2)],
                distance: [Number(byId('distanceMin').value) || 0, Number(byId('distanceMax').value) || 25000],
                spawnChance: Math.max(1, Math.min(100, Number(byId('chance').value) || 100)),
                avoidStartingSector: byId('avoidStart').checked,
            };
        },
    };`,
    });
};

/**
 * Sentences about the wirings that did not happen.
 *
 * @param wiring the outcomes by key.
 * @param manifests the candidate manifests, for the ambiguous case.
 * @returns the sentences, empty when everything was wired.
 */
export const wiringNotes = (wiring: Record<string, string>, manifests?: string[]): string[] => {
    const unwired = Object.entries(wiring).filter(
        ([, outcome]) => outcome !== 'written' && outcome !== 'present' && outcome !== 'skipped'
    );
    if (unwired.length === 0) return [];
    const reason = unwired[0][1];
    if (reason === 'ambiguousManifest') {
        return [
            l10n.t(
                'The mod has several manifests and none is mod.rules, so the actions wiring it in are yours to write. Candidates: {0}.',
                (manifests ?? []).join(', ')
            ),
        ];
    }
    if (reason === 'manifestUnusable') {
        return [
            l10n.t(
                "The mod's Actions come from an included file, which cannot be appended to, so the actions wiring it in are yours to write."
            ),
        ];
    }
    return [l10n.t('Some of it could not be wired in: {0}.', unwired.map(([key]) => key).join(', '))];
};

/**
 * Why nothing was created, for the creation wizards that share the faction command's failures.
 *
 * @param failure the server's reason.
 * @returns the message.
 */
export const creationFailureMessage = (failure: string): string => {
    switch (failure) {
        case 'noModRoot':
            return l10n.t('Cosmoteer: this folder is in no mod. Open a mod with a mod.rules manifest first.');
        case 'notEditable':
            return l10n.t(
                "Cosmoteer: this is the game's own data or somebody else's installed mod, which is not yours to add to."
            );
        case 'noGameRoot':
            return l10n.t(
                "Cosmoteer: the game path is unset, so the game's own files this builds on could not be read."
            );
        case 'invalidId':
            return l10n.t('Cosmoteer: an id is one word of letters, digits and underscores.');
        case 'idTaken':
            return l10n.t('Cosmoteer: something of that id already exists.');
        case 'pathTaken':
            return l10n.t('Cosmoteer: a folder for that id is already there, so nothing was created.');
        case 'writeFailed':
            return l10n.t('Cosmoteer: the files could not be written, so nothing was created.');
        default:
            return l10n.t('Cosmoteer: nothing was created ({0}).', failure);
    }
};
