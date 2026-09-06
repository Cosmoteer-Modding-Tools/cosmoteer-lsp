import { ExtensionContext, ViewColumn, Webview, l10n, window } from 'vscode';
import { webviewShell } from '../webview-util';

/**
 * A form in a webview panel, the shape every creation wizard asks its questions in. The panel keeps
 * its state when the author clicks elsewhere or looks at another file, which is what a chain of
 * input boxes cannot do, and the page validates as the author types.
 *
 * The form's fields and its validation are the wizard's own: it hands over the HTML of its fields
 * and a script that validates them and builds the answer, and gets the answer back as plain JSON.
 */

/** What a wizard puts on its form. */
export interface WizardFormSpec {
    /** The panel's title and the heading on the page. */
    title: string;
    /** The sentence under the heading saying what the form makes. */
    lead: string;
    /** The fields, as HTML. Inputs carry ids the script reads. */
    fieldsHtml: string;
    /** Lines shown under the fields about what will be written, already escaped. */
    facts: string[];
    /**
     * The page script's body. It runs with `vscode` (the API), `strings` (the localized messages)
     * and `form` (the form element) in scope and must define `window.wizard = { validate, answer }`:
     * `validate()` returns an error text or an empty string and enables the submit button, and
     * `answer()` returns the JSON the wizard gets back.
     */
    script: string;
    /** The localized messages the script looks up by name. */
    strings: Record<string, string>;
    /** The submit button's caption. */
    submit: string;
    /**
     * Which file pickers the form offers, keyed by the id the page posts. The editor's own dialog
     * opens for each, since a page cannot read a path off a file input, and the path goes back to
     * the page as a `picked` message.
     */
    pickers?: Record<string, { filters: Record<string, string[]>; openLabel: string }>;
}

/** What the page posts back. */
type FormMessage = { type: 'submit'; answer: unknown } | { type: 'pick'; what: string } | { type: 'cancel' };

/**
 * Escapes text for an HTML attribute or text node.
 *
 * @param text the text.
 * @returns the text with the five markup characters escaped.
 */
export const escapeHtml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Serializes a value into a script, with the one character that could end the script escaped.
 *
 * @param value the value.
 * @returns a JSON literal safe inside a script element.
 */
export const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * Shows a wizard's form and waits for it to be sent or closed.
 *
 * @param context the extension context, for the page's content-security policy.
 * @param spec the form.
 * @returns the answer the page built, or undefined when the form was closed instead.
 */
export const showWizardForm = <T>(context: ExtensionContext, spec: WizardFormSpec): Promise<T | undefined> =>
    new Promise((resolve) => {
        const panel = window.createWebviewPanel('cosmoteerWizard', spec.title, ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        let settled = false;
        const settle = (answer: T | undefined): void => {
            if (settled) return;
            settled = true;
            resolve(answer);
            panel.dispose();
        };
        panel.webview.onDidReceiveMessage(async (message: FormMessage) => {
            if (message.type === 'submit') {
                settle(message.answer as T);
            } else if (message.type === 'pick') {
                const picker = spec.pickers?.[message.what];
                if (!picker) return;
                const picked = await window.showOpenDialog({ canSelectMany: false, filters: picker.filters, openLabel: picker.openLabel });
                const path = picked?.[0]?.fsPath;
                if (path && !settled) await panel.webview.postMessage({ type: 'picked', what: message.what, path });
            } else if (message.type === 'cancel') {
                settle(undefined);
            }
        });
        panel.onDidDispose(() => settle(undefined));
        panel.webview.html = formHtml(context, panel.webview, spec);
    });

/**
 * The page: the heading, the wizard's fields, the facts, the two buttons, and the plumbing script
 * around the wizard's own.
 *
 * @param context the extension context.
 * @param webview the panel's webview.
 * @param spec the form.
 * @returns the page's HTML.
 */
const formHtml = (context: ExtensionContext, webview: Webview, spec: WizardFormSpec): string => {
    const { nonce, csp } = webviewShell(webview, context.extensionUri);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(spec.title)}</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 1.5rem 2rem; max-width: 42rem; }
h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 0.25rem; }
p.lead { margin: 0 0 1.5rem; color: var(--vscode-descriptionForeground); }
.field { margin-bottom: 1.25rem; }
.row { display: flex; gap: 1rem; flex-wrap: wrap; }
.row .field { flex: 1 1 10rem; }
label { display: block; font-weight: 600; margin-bottom: 0.3rem; }
label.inline { display: inline; font-weight: normal; }
.hint { color: var(--vscode-descriptionForeground); margin-top: 0.3rem; }
.error { color: var(--vscode-errorForeground); margin-top: 0.3rem; min-height: 1.2em; }
input[type=text], input[type=number], select { width: 100%; box-sizing: border-box; padding: 0.4rem 0.5rem; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; font: inherit; }
input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
input[type=color] { width: 4rem; height: 2rem; padding: 0; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); vertical-align: middle; }
input[type=checkbox] { vertical-align: middle; margin-right: 0.4rem; }
.swatch, .picked { display: inline-block; margin-left: 0.75rem; vertical-align: middle; color: var(--vscode-descriptionForeground); word-break: break-all; }
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
<h1>${escapeHtml(spec.title)}</h1>
<p class="lead">${escapeHtml(spec.lead)}</p>
<form id="form">
${spec.fieldsHtml}
<div class="error" id="formError"></div>
<div class="facts">
${spec.facts.map((fact) => `<div>${fact}</div>`).join('\n')}
</div>
<div class="actions">
<button class="primary" id="create" type="submit" disabled>${escapeHtml(spec.submit)}</button>
<button class="secondary" id="cancel" type="button">${escapeHtml(l10n.t('Cancel'))}</button>
</div>
</form>
<script nonce="${nonce}">
(function () {
    var vscode = acquireVsCodeApi();
    var strings = ${scriptJson(spec.strings)};
    var form = document.getElementById('form');
    var create = document.getElementById('create');
    var formError = document.getElementById('formError');
    ${spec.script}
    var run = function () {
        var problem = window.wizard.validate() || '';
        formError.textContent = problem;
        create.disabled = !!problem;
    };
    form.addEventListener('input', run);
    form.addEventListener('change', run);
    form.addEventListener('submit', function (event) {
        event.preventDefault();
        run();
        if (create.disabled) return;
        create.disabled = true;
        vscode.postMessage({ type: 'submit', answer: window.wizard.answer() });
    });
    document.getElementById('cancel').addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-pick]'), function (button) {
        button.addEventListener('click', function () { vscode.postMessage({ type: 'pick', what: button.getAttribute('data-pick') }); });
    });
    window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || message.type !== 'picked') return;
        if (window.wizard.picked) window.wizard.picked(message.what, message.path);
        run();
    });
    run();
    var first = form.querySelector('input[type=text]');
    if (first) first.focus();
})();
</script>
</body>
</html>`;
};
