import { ExtensionContext, ViewColumn, l10n, window } from 'vscode';
import { webviewShell } from '../webview-util';

/**
 * The form a new faction is described on: its id, the name the game shows, and the colour of its
 * border on the map. It lives in a webview panel rather than a chain of input boxes so that a click
 * elsewhere, a switch of editor or a look at another file does not throw the answers away: the
 * panel keeps its state until the form is sent or closed.
 */

/** What the form asks for. */
export interface NewFactionForm {
    id: string;
    name: string;
    /** The border colour as red, green and blue, each 0 to 255. */
    color: [number, number, number];
    /** A PNG to copy in as the icon, absent when the game's own stands in. */
    icon?: string;
    /** A saved ship to copy in as the FTL beacon, absent when the game's own stands in. */
    beaconShip?: string;
    /** Whether a lore page is written for the codex. */
    lore: boolean;
}

/** What the form needs to know to validate and to explain itself. */
export interface NewFactionFormFacts {
    /** The mod the faction is written into, shown by its folder name. */
    modRoot: string;
    /** Ids that are already taken, matched case-insensitively. */
    takenIds: readonly string[];
    /** The player indexes the faction will get, military first. */
    playerIndexes: [number, number];
}

/** The border colour a faction starts with, a purple no game faction uses. */
const DEFAULT_COLOR: [number, number, number] = [143, 48, 220];

/** What the page posts back. */
type FormMessage =
    | { type: 'submit'; id: string; name: string; color: string; icon?: string; beaconShip?: string; lore: boolean }
    | { type: 'pick'; what: 'icon' | 'beaconShip' }
    | { type: 'cancel' };

/**
 * Escapes text for an HTML attribute or text node.
 *
 * @param text the text.
 * @returns the text with the five markup characters escaped.
 */
const escapeHtml = (text: string): string =>
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/**
 * Reads a `#rrggbb` colour into its three channels.
 *
 * @param hex the colour the page sent.
 * @returns the channels, or the default colour when the text is not one.
 */
const channelsOf = (hex: string): [number, number, number] => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!match) return DEFAULT_COLOR;
    return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
};

/**
 * Shows the form and waits for it to be sent or closed.
 *
 * @param context the extension context, for the page's content-security policy.
 * @param facts what the form validates against and tells the author.
 * @returns what was entered, or undefined when the form was closed instead.
 */
export const showNewFactionForm = (
    context: ExtensionContext,
    facts: NewFactionFormFacts
): Promise<NewFactionForm | undefined> =>
    new Promise((resolve) => {
        const panel = window.createWebviewPanel('cosmoteerNewFaction', l10n.t('New Faction'), ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        let settled = false;
        const settle = (form: NewFactionForm | undefined): void => {
            if (settled) return;
            settled = true;
            resolve(form);
            panel.dispose();
        };
        panel.webview.onDidReceiveMessage(async (message: FormMessage) => {
            if (message.type === 'submit') {
                settle({
                    id: message.id.trim(),
                    name: message.name.trim(),
                    color: channelsOf(message.color),
                    icon: message.icon || undefined,
                    beaconShip: message.beaconShip || undefined,
                    lore: !!message.lore,
                });
            } else if (message.type === 'pick') {
                // The page cannot read a path off a file input, so the editor's own dialog picks
                // the file and hands the path back to the page.
                const picked = await window.showOpenDialog({
                    canSelectMany: false,
                    filters:
                        message.what === 'icon'
                            ? { [l10n.t('PNG image')]: ['png'] }
                            : { [l10n.t('Saved ship')]: ['png'] },
                    openLabel: message.what === 'icon' ? l10n.t('Use as icon') : l10n.t('Use as beacon'),
                });
                const path = picked?.[0]?.fsPath;
                if (path && !settled) await panel.webview.postMessage({ type: 'picked', what: message.what, path });
            } else if (message.type === 'cancel') {
                settle(undefined);
            }
        });
        panel.onDidDispose(() => settle(undefined));
        panel.webview.html = formHtml(context, panel.webview, facts);
    });

/**
 * The page: three fields, the facts about the mod, and a script that validates as the author types
 * and posts the answers back.
 *
 * @param context the extension context.
 * @param webview the panel's webview.
 * @param facts what the form validates against and tells the author.
 * @returns the page's HTML.
 */
const formHtml = (context: ExtensionContext, webview: import('vscode').Webview, facts: NewFactionFormFacts): string => {
    const { nonce, csp } = webviewShell(webview, context.extensionUri);
    const modName = facts.modRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? facts.modRoot;
    const defaultHex = `#${DEFAULT_COLOR.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
    const strings = {
        invalidId: l10n.t('One word: letters, digits and underscores, starting with a letter.'),
        takenId: l10n.t('A faction of that id already exists.'),
        emptyName: l10n.t('Give it a name.'),
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(l10n.t('New Faction'))}</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 1.5rem 2rem; max-width: 40rem; }
h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 0.25rem; }
p.lead { margin: 0 0 1.5rem; color: var(--vscode-descriptionForeground); }
.field { margin-bottom: 1.25rem; }
label { display: block; font-weight: 600; margin-bottom: 0.3rem; }
.hint { color: var(--vscode-descriptionForeground); margin-top: 0.3rem; }
.error { color: var(--vscode-errorForeground); margin-top: 0.3rem; min-height: 1.2em; }
input[type=text] { width: 100%; box-sizing: border-box; padding: 0.4rem 0.5rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; }
input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); }
input[type=color] { width: 4rem; height: 2rem; padding: 0; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); vertical-align: middle; }
.swatch { display: inline-block; margin-left: 0.75rem; vertical-align: middle; font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
.picked { display: inline-block; margin-left: 0.75rem; vertical-align: middle; color: var(--vscode-descriptionForeground); word-break: break-all; }
input[type=checkbox] { vertical-align: middle; margin-right: 0.4rem; }
.facts { border-left: 3px solid var(--vscode-textBlockQuote-border); background: var(--vscode-textBlockQuote-background); padding: 0.6rem 0.9rem; margin: 1.5rem 0; }
.facts div { margin: 0.15rem 0; }
.actions { display: flex; gap: 0.6rem; margin-top: 1rem; }
button { padding: 0.45rem 1rem; border: none; border-radius: 2px; font: inherit; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:disabled { opacity: 0.5; cursor: default; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
<h1>${escapeHtml(l10n.t('New Faction'))}</h1>
<p class="lead">${escapeHtml(l10n.t('Fill in the three things every faction needs. Everything else is written for you and wired in from the manifest.'))}</p>
<form id="form">
<div class="field">
<label for="id">${escapeHtml(l10n.t('Faction id'))}</label>
<input id="id" type="text" autocomplete="off" spellcheck="false" autofocus />
<div class="hint">${escapeHtml(l10n.t('How ships and sectors name it. One word: letters, digits and underscores.'))}</div>
<div class="error" id="idError"></div>
</div>
<div class="field">
<label for="name">${escapeHtml(l10n.t('Display name'))}</label>
<input id="name" type="text" autocomplete="off" />
<div class="hint">${escapeHtml(l10n.t('The name the game shows, written to every language file of the mod.'))}</div>
<div class="error" id="nameError"></div>
</div>
<div class="field">
<label for="color">${escapeHtml(l10n.t('Border colour'))}</label>
<input id="color" type="color" value="${defaultHex}" /><span class="swatch" id="swatch">${defaultHex}</span>
<div class="hint">${escapeHtml(l10n.t('The colour of its territory border on the galaxy map.'))}</div>
</div>
<div class="field">
<label>${escapeHtml(l10n.t('Icon'))}</label>
<button class="secondary" id="pickIcon" type="button">${escapeHtml(l10n.t('Pick a PNG…'))}</button>
<span class="picked" id="iconPath">${escapeHtml(l10n.t("the game's own until you pick one"))}</span>
<div class="hint">${escapeHtml(l10n.t('A square PNG, copied into the faction folder. The game shows it on the map and in the codex.'))}</div>
</div>
<div class="field">
<label>${escapeHtml(l10n.t('FTL beacon ship'))}</label>
<button class="secondary" id="pickBeacon" type="button">${escapeHtml(l10n.t('Pick a .ship.png…'))}</button>
<span class="picked" id="beaconPath">${escapeHtml(l10n.t("the game's own until you pick one"))}</span>
<div class="hint">${escapeHtml(l10n.t('The saved ship the beacon at each of its systems is built from, copied into the faction folder.'))}</div>
</div>
<div class="field">
<label><input id="lore" type="checkbox" checked /> ${escapeHtml(l10n.t('Write a lore page for the codex'))}</label>
<div class="hint">${escapeHtml(l10n.t('A page under the codex lore tab with the icon and three paragraphs, each a key in the language files for you to fill.'))}</div>
</div>
<div class="facts">
<div>${escapeHtml(l10n.t('Written into the mod {0}.', modName))}</div>
<div>${escapeHtml(l10n.t('Player indexes {0} (military) and {1} (civilian), the first free block above the game’s own.', String(facts.playerIndexes[0]), String(facts.playerIndexes[1])))}</div>
<div>${escapeHtml(l10n.t('The icon and the FTL beacon start as the game’s own, named in the files for you to replace.'))}</div>
</div>
<div class="actions">
<button class="primary" id="create" type="submit" disabled>${escapeHtml(l10n.t('Create faction'))}</button>
<button class="secondary" id="cancel" type="button">${escapeHtml(l10n.t('Cancel'))}</button>
</div>
</form>
<script nonce="${nonce}">
(function () {
    var vscode = acquireVsCodeApi();
    var taken = ${JSON.stringify(facts.takenIds.map((id) => id.toLowerCase())).replace(/</g, '\\u003c')};
    var strings = ${JSON.stringify(strings).replace(/</g, '\\u003c')};
    var idField = document.getElementById('id');
    var nameField = document.getElementById('name');
    var colorField = document.getElementById('color');
    var swatch = document.getElementById('swatch');
    var idError = document.getElementById('idError');
    var nameError = document.getElementById('nameError');
    var create = document.getElementById('create');
    var iconPath = document.getElementById('iconPath');
    var beaconPath = document.getElementById('beaconPath');
    var picked = { icon: '', beaconShip: '' };
    var nameTouched = false;
    var suggestName = function (id) {
        return id.split('_').filter(Boolean).map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); }).join(' ');
    };
    var validate = function () {
        var id = idField.value.trim();
        var name = nameField.value.trim();
        var idProblem = !/^[A-Za-z][A-Za-z0-9_]*$/.test(id) ? (id ? strings.invalidId : '') : taken.indexOf(id.toLowerCase()) >= 0 ? strings.takenId : '';
        var nameProblem = nameTouched && !name ? strings.emptyName : '';
        idError.textContent = idProblem;
        nameError.textContent = nameProblem;
        create.disabled = !id || !!idProblem || !name;
    };
    idField.addEventListener('input', function () {
        if (!nameTouched) nameField.value = suggestName(idField.value.trim());
        validate();
    });
    nameField.addEventListener('input', function () {
        nameTouched = nameField.value.trim().length > 0;
        validate();
    });
    colorField.addEventListener('input', function () { swatch.textContent = colorField.value; });
    document.getElementById('pickIcon').addEventListener('click', function () { vscode.postMessage({ type: 'pick', what: 'icon' }); });
    document.getElementById('pickBeacon').addEventListener('click', function () { vscode.postMessage({ type: 'pick', what: 'beaconShip' }); });
    window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || message.type !== 'picked') return;
        picked[message.what] = message.path;
        (message.what === 'icon' ? iconPath : beaconPath).textContent = message.path;
    });
    document.getElementById('form').addEventListener('submit', function (event) {
        event.preventDefault();
        validate();
        if (create.disabled) return;
        create.disabled = true;
        vscode.postMessage({
            type: 'submit',
            id: idField.value,
            name: nameField.value,
            color: colorField.value,
            icon: picked.icon,
            beaconShip: picked.beaconShip,
            lore: document.getElementById('lore').checked,
        });
    });
    document.getElementById('cancel').addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
    idField.focus();
})();
</script>
</body>
</html>`;
};
