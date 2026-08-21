import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { aliasRootIndex } from '../../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { ParserResultRegistrar } from '../../../src/registrar/parser-result-registrar';
import { flattenGroup, invalidateEffectiveChainCache } from '../../../src/semantics/effective-group';
import { inheritanceEntriesOf } from '../../../src/semantics/reference-resolver';
import { InheritedMember, inheritedMembersFor } from '../../../src/features/completion/inherited-members';
import { buildActionRootingForScan, resetActionRootingForScan } from '../../scan-rooting-helper';

// Truth check of the inherited-field annotation over a whole tree. Every annotation makes a claim
// about another file ("the base writes this here"), so every claim is checked against that file: the
// line the annotation names has to be a line that really declares that member. A mismatch is a lie
// in the popup and fails the scan. The counts written alongside are the triage material: how many
// groups inherit, how many the annotation speaks for, and how many it stays silent about and why.
// Self-skips without the game tree and an output file. INHERITED_SCAN_DIR picks the tree to scan
// (default the game's own data), INHERITED_MODSCAN_OUT runs the same check over installed mods.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const SCAN_DIR = process.env.INHERITED_SCAN_DIR ?? DATA_DIR;
const OUT_FILE = process.env.INHERITED_SCAN_OUT ?? '';
const MOD_OUT_FILE = process.env.INHERITED_MODSCAN_OUT ?? '';
const HAVE_DATA = existsSync(DATA_DIR) && existsSync(SCAN_DIR) && !!OUT_FILE;
const HAVE_MODS = existsSync(DATA_DIR) && existsSync(MODS_DIR) && !!MOD_OUT_FILE;
const token = CancellationToken.None;

/** Every `.rules` file under a folder. */
const rulesFilesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(dir, entry);
            let stats;
            try {
                stats = statSync(full);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(full);
            else if (entry.endsWith('.rules')) out.push(full);
        }
    };
    walk(root);
    return out;
};

/** What one tree's scan found. */
interface ScanTotals {
    files: number;
    groups: number;
    inheriting: number;
    spokenFor: number;
    entries: number;
    incomplete: number;
    silent: number;
    runTimeRooted: number;
    valuesConfirmed: number;
    valuesUnconfirmed: number;
}

const emptyTotals = (): ScanTotals => ({
    files: 0,
    groups: 0,
    inheriting: 0,
    spokenFor: 0,
    entries: 0,
    incomplete: 0,
    silent: 0,
    runTimeRooted: 0,
    valuesConfirmed: 0,
    valuesUnconfirmed: 0,
});

/** Adds one tree's totals onto another's. */
const addTotals = (into: ScanTotals, from: ScanTotals): void => {
    for (const key of Object.keys(into) as Array<keyof ScanTotals>) into[key] += from[key];
};

/** Source lines of a file the annotation named, read once per file. */
const sourceCache = new Map<string, string[] | null>();

/**
 * The lines of the file an origin uri names.
 *
 * @param uri the uri or plain path a parsed document carries.
 * @returns the file's lines, or null when it could not be read.
 */
const linesOf = (uri: string): string[] | null => {
    const cached = sourceCache.get(uri);
    if (cached !== undefined) return cached;
    let lines: string[] | null = null;
    try {
        const path = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
        lines = readFileSync(path, 'utf8').split('\n');
    } catch {
        lines = null;
    }
    sourceCache.set(uri, lines);
    return lines;
};

/** Regex-safe form of a member name. */
const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every number written on a line, so a value can be confirmed without caring how it is spelled. */
const numbersOn = (line: string): number[] =>
    (line.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [])
        .map(Number)
        .filter((value) => !Number.isNaN(value));

/**
 * Checks one annotation against the file it names.
 *
 * @param name the member name the annotation was made for.
 * @param supplied what the annotation says about it.
 * @param totals the running counts, for the value confirmations.
 * @param unconfirmed collects a sample of values that were not found on the line they were read from.
 * @returns why the claim could not be confirmed, or undefined when it holds.
 */
const disproves = (
    name: string,
    supplied: InheritedMember,
    totals: ScanTotals,
    unconfirmed: string[]
): string | undefined => {
    const lines = linesOf(supplied.uri);
    if (!lines) return `the named file could not be read (${supplied.uri})`;
    const line = lines[supplied.line - 1];
    if (line === undefined) return `the named line ${supplied.line} is past the end of ${supplied.uri}`;
    if (!new RegExp(`(?:^|[^A-Za-z0-9_])${escaped(name)}(?![A-Za-z0-9_])`, 'i').test(line)) {
        return `line ${supplied.line} of ${supplied.uri} declares no ${name}: ${line.trim()}`;
    }
    // The value is confirmed where it can be: a written token has to be on that line, and a finite
    // number has to be there as a number, since `.5` and `0.5` are the same value spelled two ways.
    // An empty text and an `Infinity` are matched as text, since neither survives a numeric compare.
    const written = /^`(.*)`$/.exec(supplied.value)?.[1];
    if (written === undefined || written.endsWith('…')) return undefined;
    const asNumber = written === '' ? Number.NaN : Number(written);
    const found = Number.isFinite(asNumber)
        ? numbersOn(line).includes(asNumber)
        : line.includes(written === '' ? '""' : written);
    if (found) {
        totals.valuesConfirmed++;
    } else {
        totals.valuesUnconfirmed++;
        if (unconfirmed.length < 60) {
            unconfirmed.push(`${name} = ${supplied.value} :: ${supplied.uri}:${supplied.line} :: ${line.trim()}`);
        }
    }
    return undefined;
};

/** Every group of a document, in document order. */
const groupsOf = (document: AbstractNodeDocument): GroupNode[] => {
    const groups: GroupNode[] = [];
    const walk = (node: AbstractNode): void => {
        if (isGroupNode(node)) groups.push(node);
        for (const child of isGroupNode(node) || isListNode(node) ? node.elements : []) walk(child);
    };
    for (const element of document.elements) walk(element);
    return groups;
};

/** Whether a container writes a base rooted at `~`, the form the annotation refuses to speak for. */
const namesRunTimeRoot = (group: GroupNode): boolean =>
    inheritanceEntriesOf(group).some((entry) => {
        const value = (entry as { valueType?: { type: string; value: unknown } }).valueType;
        if (!value || value.type !== 'Reference') return false;
        const reference = String(value.value);
        return (reference.startsWith('&') ? reference.slice(1) : reference).startsWith('~');
    });

/**
 * Runs the annotation over every inheriting group of a tree and checks each claim it makes.
 *
 * @param files the `.rules` files to scan.
 * @param label how the report names each file.
 * @param mismatches collects every claim that could not be confirmed.
 * @param unconfirmed collects a sample of values that were not found on the line they were read from.
 * @returns the counts for this tree.
 */
const scanFiles = async (
    files: string[],
    label: (file: string) => string,
    mismatches: string[],
    unconfirmed: string[]
): Promise<ScanTotals> => {
    const totals = emptyTotals();
    for (const file of files) {
        let document: AbstractNodeDocument;
        try {
            document = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
        } catch {
            continue;
        }
        totals.files++;
        for (const group of groupsOf(document)) {
            totals.groups++;
            if (inheritanceEntriesOf(group).length === 0) continue;
            totals.inheriting++;
            if (namesRunTimeRoot(group)) totals.runTimeRooted++;
            const supplied = await inheritedMembersFor(group, token).catch(() => new Map<string, InheritedMember>());
            if (supplied.size === 0) {
                const flattened = await flattenGroup(group, token).catch(() => undefined);
                if (!flattened || !flattened.complete) totals.incomplete++;
                else totals.silent++;
                continue;
            }
            totals.spokenFor++;
            for (const [name, member] of supplied) {
                totals.entries++;
                const disproved = disproves(name, member, totals, unconfirmed);
                if (disproved) mismatches.push(`${label(file)} :: ${name} :: ${disproved}`);
            }
        }
        if (totals.files % 200 === 0) {
            ParserResultRegistrar.instance.clear();
            sourceCache.clear();
            invalidateEffectiveChainCache();
        }
    }
    return totals;
};

/** The report block for one tree. */
const report = (name: string, totals: ScanTotals): string =>
    [
        `${name}: ${totals.files} files, ${totals.groups} groups, ${totals.inheriting} of them inherit`,
        `  spoken for: ${totals.spokenFor} groups, ${totals.entries} inherited members named`,
        `  silent: ${totals.incomplete} with a base that could not be read, ${totals.silent} with a readable chain that supplied nothing`,
        `  of the inheriting groups, ${totals.runTimeRooted} name a \`~\` root`,
        `  values: ${totals.valuesConfirmed} confirmed on the named line, ${totals.valuesUnconfirmed} not found there`,
    ].join('\n');

/**
 * Brings the workspace up the way a scan harness does, so cross-file bases resolve on disk.
 *
 * @returns once the workspace service and the alias index are built against the game tree.
 */
const initializeGameTree = async (): Promise<void> => {
    const parseReal = (abs: string) => parser(lexer(readFileSync(abs, 'utf8')), pathToFileURL(abs).href).value;
    const resolveRef = async (fileRef: string, fromUri: string) => {
        const rel = fileRef.replace(/[<>]/g, '').trim();
        if (!rel) return undefined;
        const withExtension = /\.[^/\\.]+$/.test(rel) ? rel : `${rel}.rules`;
        for (const abs of [
            join(dirname(fileURLToPath(fromUri)), withExtension),
            join(DATA_DIR, withExtension),
            join(dirname(DATA_DIR), withExtension),
        ]) {
            if (existsSync(abs)) {
                try {
                    return parseReal(abs);
                } catch {
                    return undefined;
                }
            }
        }
        return undefined;
    };
    globalSettings.cosmoteerPath = DATA_DIR;
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    await service.initialize(DATA_DIR, noop);
    aliasRootIndex.invalidate();
    await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);
};

describe.skipIf(!HAVE_DATA)('the inherited-field annotation over the game data', () => {
    it('names a real declaration for every field it claims is inherited', async () => {
        await initializeGameTree();
        const root = SCAN_DIR.replace(/\\/g, '/');
        const mismatches: string[] = [];
        const unconfirmed: string[] = [];
        const totals = await scanFiles(
            rulesFilesUnder(SCAN_DIR),
            (file) => file.replace(/\\/g, '/').slice(root.length + 1),
            mismatches,
            unconfirmed
        );
        const text = [
            report(root, totals),
            '',
            ...mismatches,
            '',
            'values not found on the line they were read from:',
            ...unconfirmed,
        ].join('\n');
        writeFileSync(OUT_FILE, text, 'utf8');
        console.log(text.slice(0, 4000));
        expect(totals.files).toBeGreaterThan(0);
        // The whole point of building this on the chain flattener is that a caret base resolves, and
        // the game's own data is written almost entirely in caret bases, so a scan that speaks for
        // nothing would mean the annotation never fires where it matters.
        expect(totals.spokenFor).toBeGreaterThan(0);
        expect(mismatches).toEqual([]);
    }, 3_000_000);
});

describe.skipIf(!HAVE_MODS)('the inherited-field annotation over installed workshop mods', () => {
    it('names a real declaration for every field it claims is inherited', async () => {
        await initializeGameTree();
        const modDirs = readdirSync(MODS_DIR)
            .map((entry) => join(MODS_DIR, entry))
            .filter((path) => {
                try {
                    return statSync(path).isDirectory();
                } catch {
                    return false;
                }
            });
        const mismatches: string[] = [];
        const unconfirmed: string[] = [];
        const blocks: string[] = [];
        const overall = emptyTotals();
        try {
            for (const modDir of modDirs) {
                const modId = modDir.replace(/\\/g, '/').split('/').pop() ?? modDir;
                // Per-mod isolation, the coverage a real mod workspace has: the game tree plus this
                // one mod, with mod-action rooting built in production order so a base a manifest
                // appends is part of the chain here too.
                const folders = [DATA_DIR, modDir];
                ReverseIncludeIndex.instance.reset();
                await ReverseIncludeIndex.instance.ensureBuilt(folders, token).catch(() => undefined);
                await buildActionRootingForScan(folders, token);
                invalidateEffectiveChainCache();
                const totals = await scanFiles(
                    rulesFilesUnder(modDir),
                    (file) => `${modId}/${file.replace(/\\/g, '/').split(`/${modId}/`)[1] ?? file}`,
                    mismatches,
                    unconfirmed
                );
                blocks.push(report(modId, totals));
                addTotals(overall, totals);
                ParserResultRegistrar.instance.clear();
                sourceCache.clear();
            }
        } finally {
            resetActionRootingForScan();
            ReverseIncludeIndex.instance.reset();
            ParserResultRegistrar.instance.clear();
        }
        const text = [
            report(`${modDirs.length} installed mods`, overall),
            '',
            ...blocks,
            '',
            ...mismatches,
            '',
            'values not found on the line they were read from:',
            ...unconfirmed,
        ].join('\n');
        writeFileSync(MOD_OUT_FILE, text, 'utf8');
        console.log(report(`${modDirs.length} installed mods`, overall));
        expect(overall.files).toBeGreaterThan(0);
        expect(mismatches).toEqual([]);
    }, 6_000_000);
});
