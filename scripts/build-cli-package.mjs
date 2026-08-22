import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Assembles the publishable form of the lint command. Both release channels read the directory this
// writes: the npm package is published from it and the release archive is a tar of it, so the two
// carry the same files and the same version rather than being assembled twice.
//
// The layout is what `defaultServerPath` in server/src/cli/scan.ts expects: the command sits in
// `cli/` and finds the server bundle one directory above itself.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'cli-package', 'cosmoteer-rules-lint');

/** The npm package name, which is also the command it installs. */
const PACKAGE_NAME = 'cosmoteer-rules-lint';

/**
 * The manifest the package is published with.
 *
 * @param version the version the build was cut from.
 * @returns the manifest as an object.
 */
const manifest = (version) => ({
    name: PACKAGE_NAME,
    version,
    description: 'Check a Cosmoteer mod from the command line, the way the editor checks it.',
    bin: { [PACKAGE_NAME]: 'cli/lint.mjs' },
    files: ['cli/lint.mjs', 'server.mjs', 'README.md', 'LICENSE'],
    // The bundles use APIs no release before this one has, and a version that cannot run them
    // should say so at install time instead of at the first run.
    engines: { node: '>=20.0.0' },
    license: 'MIT',
    repository: {
        type: 'git',
        url: 'https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp',
    },
    bugs: { url: 'https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/issues' },
    homepage: 'https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/docs/cli.md',
    keywords: ['cosmoteer', 'modding', 'lint', 'sarif', 'rules'],
});

/** What the package page shows, kept short because the full reference lives in the repository. */
const packageReadme = (version) => `# Cosmoteer Rules Lint

Checks a Cosmoteer mod from the command line with the same rules the Cosmoteer Rules editor applies,
so a build can fail on what an author would have seen in the editor.

\`\`\`bash
npx ${PACKAGE_NAME} path/to/my-mod
npx ${PACKAGE_NAME} path/to/my-mod --assert-loads
\`\`\`

The check reads the game's own \`Data\` tree, so Cosmoteer has to be installed on the machine that
runs it. A Steam install is found on its own, and \`--game\` points the run at any other one.

Run \`npx ${PACKAGE_NAME} --help\` for every option, every exit code and the list of rule ids.

Full documentation:
https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp/blob/master/docs/cli.md

Version ${version}.
`;

/**
 * Copies the built command, giving it the shebang an npm `bin` needs.
 *
 * The bundler writes one banner for all three entry points, and a shebang belongs to this one
 * alone, so it is prepended here rather than baked into a bundle the extension host also loads.
 *
 * @param from the built command.
 * @param to where the packaged command goes.
 * @returns once the file is written.
 */
const copyCommand = async (from, to) => {
    const built = await readFile(from, 'utf8');
    const withShebang = built.startsWith('#!') ? built : `#!/usr/bin/env node\n${built}`;
    await writeFile(to, withShebang, 'utf8');
};

/**
 * Fails with a readable message when the build the package is assembled from is missing.
 *
 * @param path the file that has to exist.
 * @returns once the file has been read.
 */
const requireBuilt = async (path) => {
    try {
        await readFile(path);
    } catch {
        throw new Error(`${path} is missing. Run "node esbuild.mjs --production" before packaging.`);
    }
};

const main = async () => {
    const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
    const server = join(root, 'out', 'server', 'src', 'server.mjs');
    const command = join(root, 'out', 'server', 'src', 'cli', 'lint.mjs');
    await requireBuilt(server);
    await requireBuilt(command);

    await rm(join(root, 'cli-package'), { recursive: true, force: true });
    await mkdir(join(outDir, 'cli'), { recursive: true });
    await writeFile(join(outDir, 'package.json'), `${JSON.stringify(manifest(version), null, 2)}\n`, 'utf8');
    await writeFile(join(outDir, 'README.md'), packageReadme(version), 'utf8');
    await copyFile(join(root, 'LICENSE'), join(outDir, 'LICENSE'));
    await copyFile(server, join(outDir, 'server.mjs'));
    await copyCommand(command, join(outDir, 'cli', 'lint.mjs'));

    console.log(`${PACKAGE_NAME} ${version} assembled in ${outDir}`);
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
