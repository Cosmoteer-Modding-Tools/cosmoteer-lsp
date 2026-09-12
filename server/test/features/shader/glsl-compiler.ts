import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Compiles translated GLSL the way the preview webview does, by handing it to a real GLSL compiler.
 * "Leaves no HLSL behind" is a much weaker claim than "compiles": every one of the nine vanilla
 * shaders the translator used to break on passed a leftovers grep and then failed in the driver. There
 * is no GLSL compiler in the dependency tree, so this drives the one already installed on the machine,
 * a headless Chromium, over a generated page that reports its results in the DOM. Without a browser the
 * caller self-skips, the same way the vanilla tests self-skip without the game install.
 */

/** One program to compile: a fragment shader, optionally paired with its own vertex stage. */
export interface GlslProgram {
    /** Identifies the program in the results (the shader path plus which stage pair it is). */
    readonly id: string;
    /** The fragment shader source. */
    readonly fragment: string;
    /** The vertex shader source, or undefined to use the preview's fixed-quad vertex shader. */
    readonly vertex?: string;
}

/** The candidate browser binaries, in the order they are tried. */
const BROWSER_CANDIDATES: readonly string[] = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * The headless browser to compile with.
 *
 * @returns the binary path, or null when no browser is installed and the caller should skip.
 */
export const findBrowser = (): string | null => {
    const configured = process.env.CHROME_PATH;
    if (configured && existsSync(configured)) return configured;
    return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
};

/** The preview's fixed-quad vertex shader, used for a program whose shader has no vertex stage. */
const QUAD_VERTEX = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
varying vec4 vColor;
uniform vec4 uTint;
uniform vec2 uQuadScale;
uniform vec4 uUvRect;
void main() {
    vUv = uUvRect.xy + aUv * uUvRect.zw;
    vColor = uTint;
    gl_Position = vec4(aPos * uQuadScale, 0.0, 1.0);
}`;

/**
 * The page source: it compiles and links every program in a WebGL context and writes one JSON blob
 * into the DOM, which `--dump-dom` then returns. The ES 3.00 upgrade mirrors `media/shader-preview.js`,
 * so what is compiled here is what the webview compiles.
 *
 * @param programs the programs to compile.
 * @returns the HTML source.
 */
const compilePage = (programs: readonly GlslProgram[]): string => {
    const json = JSON.stringify(programs).replace(/<\/script/g, '<\\/script');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<canvas id="c" width="32" height="32"></canvas>
<pre id="out"></pre>
<script id="data" type="application/json">${json}</script>
<script>
const QUAD_VERTEX = ${JSON.stringify(QUAD_VERTEX)};
function upgradeToEs3(source, isVertex) {
    let src = source.replace(/#extension GL_OES_standard_derivatives : enable\\n?/g, '');
    src = src.replace('{ return texture2D(t, uv); }', '{ return textureLod(t, uv, lod); }');
    src = src.replace('{ return vec2(256.0, 256.0); }', '{ return vec2(textureSize(t, 0)); }');
    if (isVertex) {
        src = src.replace(/\\battribute\\b/g, 'in').replace(/\\bvarying\\b/g, 'out');
    } else {
        src = src.replace(/\\bvarying\\b/g, 'in');
        src = src.replace(/\\bgl_FragColor\\b/g, 'pvFragColor');
        src = src.replace('precision highp float;', 'precision highp float;\\nout highp vec4 pvFragColor;');
    }
    src = src.replace(/\\btexture2D\\s*\\(/g, 'texture(');
    return '#version 300 es\\n' + src;
}
function run(gl, isGL2, program) {
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, isGL2 ? upgradeToEs3(source, type === gl.VERTEX_SHADER) : source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = String(gl.getShaderInfoLog(shader) || 'unknown').trim();
            gl.deleteShader(shader);
            return { error: log };
        }
        return { shader: shader };
    };
    const v = compile(gl.VERTEX_SHADER, program.vertex || QUAD_VERTEX);
    if (v.error) return 'vertex shader: ' + v.error;
    const f = compile(gl.FRAGMENT_SHADER, program.fragment);
    if (f.error) return 'fragment shader: ' + f.error;
    const linked = gl.createProgram();
    gl.attachShader(linked, v.shader);
    gl.attachShader(linked, f.shader);
    gl.bindAttribLocation(linked, 0, 'aPos');
    gl.bindAttribLocation(linked, 1, 'aUv');
    gl.linkProgram(linked);
    const ok = gl.getProgramParameter(linked, gl.LINK_STATUS);
    const log = ok ? null : 'link: ' + String(gl.getProgramInfoLog(linked) || 'unknown').trim();
    gl.deleteProgram(linked);
    return log;
}
const programs = JSON.parse(document.getElementById('data').textContent);
const gl = document.getElementById('c').getContext('webgl2') || document.getElementById('c').getContext('webgl');
const isGL2 = !!(gl && gl.texStorage2D);
if (gl && !isGL2) gl.getExtension('OES_standard_derivatives');
const failures = {};
for (const program of programs) {
    const error = gl ? run(gl, isGL2, program) : 'no webgl context';
    if (error) failures[program.id] = error;
}
document.getElementById('out').textContent =
    'RESULT_BEGIN' + JSON.stringify({ context: gl ? (isGL2 ? 'webgl2' : 'webgl') : null, failures: failures }) + 'RESULT_END';
</script></body></html>`;
};

/** Turns the XML entities `--dump-dom` escapes the report with back into their characters. */
const decodeEntities = (text: string): string =>
    text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');

/**
 * Compiles every program and reports the ones that failed.
 *
 * @param programs the programs to compile.
 * @param browser the browser binary, from {@link findBrowser}.
 * @returns the compile or link error per failing program id, empty when they all compiled.
 */
export const compileGlslPrograms = (
    programs: readonly GlslProgram[],
    browser: string
): Record<string, string> => {
    const directory = mkdtempSync(join(tmpdir(), 'cosmoteer-glsl-'));
    try {
        const page = join(directory, 'compile.html');
        writeFileSync(page, compilePage(programs));
        const dom = execFileSync(
            browser,
            [
                '--headless=new',
                '--disable-gpu',
                '--enable-unsafe-swiftshader',
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--no-sandbox',
                `--user-data-dir=${join(directory, 'profile')}`,
                '--virtual-time-budget=120000',
                '--dump-dom',
                `file:///${page.replace(/\\/g, '/')}`,
            ],
            { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const begin = dom.indexOf('RESULT_BEGIN');
        const end = dom.indexOf('RESULT_END');
        if (begin < 0 || end < 0) throw new Error('the compile page produced no report');
        const report = JSON.parse(decodeEntities(dom.slice(begin + 'RESULT_BEGIN'.length, end))) as {
            context: string | null;
            failures: Record<string, string>;
        };
        if (!report.context) throw new Error('the headless browser has no WebGL context');
        return report.failures;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
};
