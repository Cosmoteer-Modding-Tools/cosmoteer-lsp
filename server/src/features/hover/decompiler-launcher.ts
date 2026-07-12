import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import type { Connection } from 'vscode-languageserver';
import { globalSettings } from '../../settings';

/** The payload an "Open in decompiler" hover link carries (see decompiler-link.ts). */
export interface OpenInDecompilerArgs {
    assemblyPath?: string;
    docId?: string;
}

type DecompilerTool = 'ilspy' | 'dotpeek';
interface Decompiler {
    executable: string;
    tool: DecompilerTool;
}

/**
 * Executes the `cosmoteer.openInDecompiler` workspace command: finds the user's .NET decompiler
 * and opens the given assembly navigated to the given class. Runs on the server so VS Code and
 * the JetBrains plugin share one implementation (the server always runs on the user's machine).
 *
 * The decompiler comes from `decompiler.executablePath` when set, otherwise from an automatic
 * search of the PATH and the usual ILSpy / dotPeek install locations (see {@link findDecompiler}).
 * When nothing is found the user gets a warning with a link to the settings instead of a launch.
 *
 * @param args the assembly path and class doc-ID from the hover link.
 * @param connection the LSP connection, for the not-found warning and launch errors.
 */
export const openInDecompiler = async (args: OpenInDecompilerArgs, connection: Connection): Promise<void> => {
    if (!args?.assemblyPath || !args?.docId) return;
    const decompiler = await resolveDecompiler();
    if (!decompiler) {
        const pick = await connection.window.showWarningMessage(
            'No .NET decompiler found (searched the PATH and the usual ILSpy and dotPeek install locations). ' +
                'Set "cosmoteerLSPRules.decompiler.executablePath" to your decompiler.',
            { title: 'Open Settings' }
        );
        if (pick) void connection.sendRequest('cosmoteer/openSettings', { query: 'cosmoteerLSPRules.decompiler' });
        return;
    }
    launch(decompiler, args.assemblyPath, args.docId, connection);
};

/**
 * Starts the decompiler detached, navigated to the class. ILSpy takes the assembly plus
 * `/navigateTo:<docId>`, and dotPeek selects via `/select=<assembly>!<docId>` (both documented
 * CLI forms, and both reuse an already-running instance). A macOS `.app` bundle is started
 * through `open -a`, which is how app bundles take arguments there.
 *
 * @param decompiler the executable and its command-line style.
 * @param assemblyPath the absolute path of the assembly to open.
 * @param docId the class's XML doc-ID (`T:Namespace.Class`).
 * @param connection the LSP connection, for reporting a failed launch.
 */
const launch = (decompiler: Decompiler, assemblyPath: string, docId: string, connection: Connection): void => {
    const cliArgs =
        decompiler.tool === 'dotpeek'
            ? [`/select=${assemblyPath}!${docId}`]
            : [assemblyPath, `/navigateTo:${docId}`];
    const isMacAppBundle = process.platform === 'darwin' && decompiler.executable.toLowerCase().endsWith('.app');
    const command = isMacAppBundle ? 'open' : decompiler.executable;
    const commandArgs = isMacAppBundle ? ['-a', decompiler.executable, '--args', ...cliArgs] : cliArgs;
    const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => {
        void connection.window.showErrorMessage(`Could not start the decompiler "${decompiler.executable}": ${e.message}`);
    });
    child.unref();
};

/** The configured decompiler when `executablePath` is set, otherwise the auto-detected one. */
const resolveDecompiler = async (): Promise<Decompiler | null> => {
    const settings = globalSettings.decompiler;
    const configured = settings?.executablePath?.trim();
    if (configured) {
        const tool = settings.tool !== 'auto' && settings.tool ? settings.tool : toolFromName(configured) ?? 'ilspy';
        return { executable: configured, tool };
    }
    const preferred = settings?.tool && settings.tool !== 'auto' ? settings.tool : undefined;
    return findDecompiler(preferred);
};

/** The tool a file name implies, or undefined when the name matches neither decompiler. */
const toolFromName = (executable: string): DecompilerTool | undefined => {
    const name = path.basename(executable).toLowerCase();
    if (name.includes('dotpeek')) return 'dotpeek';
    if (name.includes('ilspy')) return 'ilspy';
    return undefined;
};

/**
 * Searches the machine for an installed decompiler, per OS. ILSpy is preferred over dotPeek
 * because its `/navigateTo` jumps straight into the decompiled source, while dotPeek's `/select`
 * only selects the type in its Assembly Explorer.
 *
 * Every PATH directory is covered on all platforms. Windows additionally covers winget shims and
 * packages, Program Files, the JetBrains Toolbox `apps` tree and the standalone dotPeek per-user
 * install dir. macOS additionally covers `/Applications` and `~/Applications` bundles (ILSpy's
 * Avalonia build). Linux additionally covers `~/.local/bin` and the dotnet tools dir, which
 * catches the AvaloniaILSpy binary and distro packages.
 *
 * @param preferred restrict the search to one tool (the non-`auto` `decompiler.tool` setting).
 * @returns the first decompiler found, or null.
 */
export const findDecompiler = async (preferred?: DecompilerTool): Promise<Decompiler | null> => {
    const candidates: Decompiler[] = [];
    const add = (tool: DecompilerTool, executable: string | undefined | null): void => {
        if (executable) candidates.push({ tool, executable });
    };

    const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const home = os.homedir();

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
        const programDirs = [
            process.env['ProgramFiles'] ?? 'C:\\Program Files',
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        ];
        for (const dir of [...pathDirs, path.join(localAppData, 'Microsoft', 'WinGet', 'Links')]) {
            add('ilspy', await existing(path.join(dir, 'ILSpy.exe')));
            add('dotpeek', await existing(path.join(dir, 'dotPeek64.exe')));
            add('dotpeek', await existing(path.join(dir, 'dotPeek32.exe')));
        }
        // winget portable packages: Packages/icsharpcode.ILSpy_<source>/(ILSpy.exe | <subdir>/ILSpy.exe).
        for (const pkg of await matching(path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'), /^icsharpcode\.ilspy/i)) {
            add('ilspy', await findFileShallow(pkg, 'ilspy.exe', 2));
        }
        for (const programs of programDirs) {
            for (const dir of await matching(programs, /^ilspy/i)) add('ilspy', await existing(path.join(dir, 'ILSpy.exe')));
            for (const dir of await matching(path.join(programs, 'JetBrains'), /dotpeek/i)) {
                add('dotpeek', await findFileShallow(dir, 'dotpeek64.exe', 2));
            }
        }
        // JetBrains Toolbox (both the 1.x `ch-0/<build>` and the 2.x flat layout) and the
        // standalone web installer's per-user location.
        for (const apps of [path.join(localAppData, 'JetBrains', 'Toolbox', 'apps'), path.join(localAppData, 'JetBrains', 'Installations')]) {
            for (const dir of await matching(apps, /dotpeek/i)) add('dotpeek', await findFileShallow(dir, 'dotpeek64.exe', 3));
        }
    } else {
        const names = ['ILSpy', 'ilspy', 'AvaloniaILSpy', 'ilspycmd'];
        for (const dir of [...pathDirs, path.join(home, '.local', 'bin'), path.join(home, '.dotnet', 'tools')]) {
            for (const name of names) add('ilspy', await existing(path.join(dir, name)));
        }
        if (process.platform === 'darwin') {
            for (const apps of ['/Applications', path.join(home, 'Applications')]) {
                for (const bundle of await matching(apps, /ilspy.*\.app$/i)) add('ilspy', bundle);
            }
        }
    }

    const eligible = preferred ? candidates.filter((c) => c.tool === preferred) : candidates;
    // Prefer ILSpy over dotPeek independent of discovery order (PATH order is not a preference).
    return eligible.find((c) => c.tool === 'ilspy') ?? eligible[0] ?? null;
};

/** The path itself when it exists as a file, else null. */
const existing = async (filePath: string): Promise<string | null> => {
    try {
        return (await fs.stat(filePath)).isFile() ? filePath : null;
    } catch {
        return null;
    }
};

/** Absolute paths of `dir`'s entries whose name matches, or empty when `dir` is unreadable. */
const matching = async (dir: string, name: RegExp): Promise<string[]> => {
    try {
        const entries = await fs.readdir(dir);
        return entries.filter((e) => name.test(e)).map((e) => path.join(dir, e));
    } catch {
        return [];
    }
};

/**
 * Breadth-first search for a file by (case-folded) name, at most `depth` directory levels below
 * `root`. That is enough for the winget and Toolbox layouts, where the executable sits one or two
 * levels under a versioned folder, without walking a whole install tree.
 *
 * @param root the directory to search under.
 * @param lowerName the lower-cased file name to find.
 * @param depth how many directory levels below `root` to descend.
 * @returns the absolute path of the first match, or null.
 */
const findFileShallow = async (root: string, lowerName: string, depth: number): Promise<string | null> => {
    let level = [root];
    for (let d = 0; d <= depth && level.length > 0; d++) {
        const next: string[] = [];
        for (const dir of level) {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.isFile() && entry.name.toLowerCase() === lowerName) return path.join(dir, entry.name);
                if (entry.isDirectory()) next.push(path.join(dir, entry.name));
            }
        }
        level = next;
    }
    return null;
};
