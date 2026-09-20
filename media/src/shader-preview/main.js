// The live shader-preview webview runtime. It receives a resolved payload from the extension (the
// material's translated GLSL, its constants and values, its textures with their sampler state, its
// blend factors, and the particle system's colour ramp) and renders the material with WebGL the way
// the game does, exposing each constant as a live control. When the translated GLSL fails to compile,
// it falls back to a plain textured render so something useful still shows. All of this runs sandboxed
// in the webview, the extension only feeds it data.
//
// This entry wires the page up: the context, the host listener, the quad buffer and the frame loop.

import { t } from '../shared/strings.js';
import { QUAD } from './constants.js';
import { loop } from './draw.js';
import { gl, initDom, statusEl, vscode } from './gl-context.js';
import { render } from './render.js';

/** Creates the context, listens for payloads, uploads the quad and starts the frame loop. */
function startPage() {
    initDom();

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'render') render(message);
        else if (message.type === 'empty') {
            statusEl.textContent = t('Place the cursor in a material with a Shader to preview it.');
        }
    });

    if (!gl) {
        statusEl.textContent = t('WebGL is not available in this webview.');
        return;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    requestAnimationFrame(loop);
    vscode.postMessage({ type: 'ready' });
}

// A webview hands the page its host bridge, and a Node process loading the bundle does not. The
// page starts only under a host, so nothing here reaches for the document on its own.
if (typeof acquireVsCodeApi !== 'undefined') startPage();
