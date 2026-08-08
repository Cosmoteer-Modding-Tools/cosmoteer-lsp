import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { expect } from 'vitest';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../../src/core/lexer/lexer';
import { parser } from '../../../../src/core/parser/parser';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode } from '../../../../src/core/ast/ast';
import { globalSettings } from '../../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { clearFsCaches } from '../../../../src/workspace/fs-cache';
import { aliasRootIndex } from '../../../../src/document/schema/alias-root';
import { ParserResultRegistrar } from '../../../../src/registrar/parser-result-registrar';
import { FullNavigationStrategy } from '../../../../src/features/navigation/full.navigation-strategy';
import { uriToFsPath } from '../../../../src/features/navigation/workspace-files';
import { getStartOfAstNode } from '../../../../src/utils/ast.utils';
import { clearSharedBaseScanCache } from '../../../../src/features/refactor/shared-base/mod-scan';
import { containerAtOffset } from '../../../../src/features/refactor/shared-base/shared-base.analysis-entry';
import { groupAtPath } from '../../../../src/features/refactor/shared-base/base-index';
import { topLevelMembersOf } from '../../../../src/features/refactor/shared-base/member-record';
import {
    applySharedBase,
    scanForSharedBases,
    SharedBaseHost,
} from '../../../../src/features/refactor/shared-base/shared-base.command';
import { SerializedPlan } from '../../../../src/features/refactor/shared-base/plan.types';

// The extraction really applied to real content, and then asked whether the files still say what
// they said. A fixture proves the mechanics; this proves the promise, which is that every field a
// participating group resolved to before the rewrite resolves to the very same thing after it, only
// from somewhere else. Nothing is done to the installed trees: each one is mirrored into a scratch
// directory first, with the rules files copied verbatim and every other file created empty, which is
// all the extraction ever asks of them (it probes assets for existence, never for content).
//
// Split across two test files rather than two cases in one, because the workspace service
// initializes exactly once per process and each tree needs its own data root.
const token = CancellationToken.None;

/** Files whose bytes the analysis actually reads. Everything else only has to exist. */
const CONTENT_EXTENSIONS = ['.rules', '.txt'];

/**
 * Mirror a tree into a scratch directory: rules text copied, every other file created empty.
 *
 * @param source the tree to mirror.
 * @param destination the scratch directory to build.
 * @returns how many files were mirrored.
 */
export const mirrorTree = (source: string, destination: string): number => {
    let count = 0;
    const walk = (from: string, to: string): void => {
        mkdirSync(to, { recursive: true });
        let entries;
        try {
            entries = readdirSync(from, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const src = join(from, entry.name);
            const dst = join(to, entry.name);
            if (entry.isDirectory()) {
                walk(src, dst);
                continue;
            }
            if (!entry.isFile()) continue;
            count++;
            if (CONTENT_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension))) {
                copyFileSync(src, dst);
            } else {
                writeFileSync(dst, '');
            }
        }
    };
    walk(source, destination);
    return count;
};

/** The names of the groups leading to a container, outermost first, so it can be found again. */
const groupPathOf = (container: GroupNode): string[] => {
    const names: string[] = [];
    let node: AbstractNode | undefined = container;
    while (node && isGroupNode(node)) {
        if (!node.identifier) return [];
        names.unshift(node.identifier.name);
        node = node.parent as AbstractNode | undefined;
    }
    return names;
};

/** What a field resolved to, as the text of the node the lookup landed on plus the file it is in. */
interface Resolved {
    text: string;
    file: string;
}

/**
 * A value's text with every line's own indentation dropped.
 *
 * A member that moves into a base file usually lands at a different depth, so a multi-line value's
 * leading tabs change while the value does not. Indentation carries no meaning between entries in
 * ObjectText, and a member holding a string that spans lines is never moved in the first place, so
 * dropping it is the difference between comparing the value and comparing the layout.
 *
 * @param text the source of the resolved node.
 * @returns the comparison form.
 */
const sameValue = (text: string): string =>
    text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n');

/**
 * Resolve a field name from a container through the real cross-file lookup, the one the game's own
 * resolution mirrors, and read back the source it landed on.
 *
 * @param navigation the lookup to use.
 * @param name the field name to ask for.
 * @param container the group to ask from.
 * @param fsPath the file that group lives in.
 * @returns what it resolved to, or undefined when it resolves to nothing.
 */
const resolveField = async (
    navigation: FullNavigationStrategy,
    name: string,
    container: GroupNode,
    fsPath: string
): Promise<Resolved | undefined> => {
    const node = (await navigation.navigate(name, container, fsPath, token).catch(() => null)) as AbstractNode | null;
    if (!node?.position) return undefined;
    const owner = getStartOfAstNode(node);
    const file = uriToFsPath(owner.uri).replace(/\\/g, '/');
    let text: string;
    try {
        text = readFileSync(file, { encoding: 'utf-8' });
    } catch {
        return undefined;
    }
    return { text: sameValue(text.slice(node.position.start, node.position.end)), file: file.toLowerCase() };
};

/** Every parse error a file has right now, so a rewrite that breaks one is caught immediately. */
const parseErrorsOf = (fsPath: string): string[] => {
    const text = readFileSync(fsPath, { encoding: 'utf-8' });
    return parser(lexer(text), fsPath).parserErrors.map((error) => `${fsPath}: ${error.message}`);
};

/** The host the command runs against, writing the edits straight to the mirror. */
const hostFor = (root: string): SharedBaseHost => ({
    folderPaths: async () => [root],
    openDocuments: () => [],
    filesChanged: () => undefined,
    applyEdit: async (changes: Record<string, TextEdit[]>) => {
        for (const [uri, edits] of Object.entries(changes)) {
            const fsPath = uriToFsPath(uri);
            const text = readFileSync(fsPath, { encoding: 'utf-8' });
            writeFileSync(fsPath, TextDocument.applyEdits(TextDocument.create(uri, 'rules', 0, text), edits));
        }
        return true;
    },
});

/** Drops every cache built from the text the rewrite has just replaced. */
const forgetEverything = (): void => {
    clearFsCaches();
    clearSharedBaseScanCache();
    ParserResultRegistrar.instance.clear();
};

/**
 * Apply one plan and prove the files still say what they said.
 *
 * @param plan the extraction to apply.
 * @param root the mirrored tree it applies inside.
 * @returns how many containers and fields were checked.
 */
const applyAndVerify = async (plan: SerializedPlan, root: string): Promise<{ containers: number; fields: number }> => {
    const navigation = new FullNavigationStrategy();

    // Before: for every participating container, what every field it declares resolves to. The moved
    // fields are the point, but the rest have to survive untouched too.
    const before: Array<{ fsPath: string; groupPath: string[]; fields: Map<string, Resolved | undefined> }> = [];
    for (const entry of plan.participants) {
        const fsPath = entry.fsPath.replace(/\\/g, '/');
        const text = readFileSync(fsPath, { encoding: 'utf-8' });
        const container = containerAtOffset(parser(lexer(text), fsPath).value, entry.offset);
        expect(container, `${fsPath} no longer holds the container at ${entry.offset}`).toBeDefined();
        const groupPath = groupPathOf(container!);
        expect(groupPath.length, `${fsPath} container has no name path`).toBeGreaterThan(0);
        const fields = new Map<string, Resolved | undefined>();
        for (const member of topLevelMembersOf(container!, text)) {
            fields.set(member.name, await resolveField(navigation, member.name, container!, fsPath));
        }
        before.push({ fsPath, groupPath, fields });
    }

    const applied = await applySharedBase(plan, undefined, hostFor(root), token);
    expect(applied.failure, `applying ${plan.label} failed`).toBeUndefined();
    forgetEverything();

    // Every file the rewrite touched still has to parse, the base file it wrote included.
    const touched = [applied.created, ...plan.participants.map((entry) => entry.fsPath)];
    expect(
        touched.flatMap((fsPath) => parseErrorsOf(fsPath.replace(/\\/g, '/'))),
        'the rewrite left parse errors behind'
    ).toEqual([]);

    // After: the same question, and every answer has to be the one from before.
    let fieldCount = 0;
    for (const entry of before) {
        const text = readFileSync(entry.fsPath, { encoding: 'utf-8' });
        const container = groupAtPath(parser(lexer(text), entry.fsPath).value, entry.groupPath);
        expect(container, `${entry.fsPath} lost ${entry.groupPath.join('/')}`).toBeDefined();
        for (const [name, was] of entry.fields) {
            const now = await resolveField(navigation, name, container!, entry.fsPath);
            fieldCount++;
            expect(now?.text, `${entry.fsPath} ${entry.groupPath.join('/')}/${name} changed value`).toBe(was?.text);
        }
        // A moved field has to come from somewhere else now, or the rewrite moved nothing.
        for (const key of plan.fields) {
            const spelling = [...entry.fields.keys()].find((name) => name.toLowerCase() === key);
            if (!spelling) continue;
            const now = await resolveField(navigation, spelling, container!, entry.fsPath);
            expect(now?.file, `${entry.fsPath} still declares ${spelling} itself`).not.toBe(
                entry.fsPath.toLowerCase()
            );
        }
    }
    return { containers: before.length, fields: fieldCount };
};

/**
 * Point the workspace service at a tree, the way the server does at startup.
 *
 * @param dataRoot the game data root to initialize against.
 * @param allowVanilla whether the game tree itself is the thing being extracted from.
 */
const initializeAgainst = async (dataRoot: string, allowVanilla: boolean): Promise<void> => {
    globalSettings.cosmoteerPath = dataRoot;
    globalSettings.allowEditingVanillaFiles = allowVanilla;
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    await service.initialize(dataRoot, noop);
    expect(service.dataRootPath, `the workspace did not initialize against ${dataRoot}`).toBeDefined();

    const parseReal = (abs: string): AbstractNodeDocument =>
        parser(lexer(readFileSync(abs, { encoding: 'utf-8' })), abs.replace(/\\/g, '/')).value;
    const root = join(dataRoot, 'cosmoteer.rules');
    if (!existsSync(root)) return;
    aliasRootIndex.invalidate();
    await aliasRootIndex.build(parseReal(root), async (fileRef: string, fromUri: string) => {
        const relative = fileRef.replace(/[<>]/g, '').trim();
        if (!relative) return undefined;
        const withExtension = /\.[^/\\.]+$/.test(relative) ? relative : `${relative}.rules`;
        for (const abs of [join(dirname(uriToFsPath(fromUri)), withExtension), join(dataRoot, withExtension)]) {
            if (existsSync(abs)) {
                try {
                    return parseReal(abs);
                } catch {
                    return undefined;
                }
            }
        }
        return undefined;
    });
};

/**
 * Apply the extractions a mirrored tree offers, verifying each one before moving to the next.
 *
 * @param label the tree's name, for the summary line.
 * @param scratch the mirrored tree to rewrite.
 * @param dataRoot the game data root to resolve against.
 * @param allowVanilla whether the game tree itself is what is being extracted from.
 * @param maxPlans how many extractions to apply.
 */
export const applyPlansOver = async (
    label: string,
    scratch: string,
    dataRoot: string,
    allowVanilla: boolean,
    maxPlans: number
): Promise<void> => {
    await initializeAgainst(dataRoot, allowVanilla);
    let applied = 0;
    let containers = 0;
    let fields = 0;
    // Re-scanned between applications on purpose: applying one plan moves the offsets every other
    // plan recorded, which is exactly what a user doing two extractions in a row hits.
    while (applied < maxPlans) {
        forgetEverything();
        const scan = await scanForSharedBases(hostFor(scratch), token);
        if (scan.plans.length === 0) break;
        const counted = await applyAndVerify(scan.plans[0], scratch);
        containers += counted.containers;
        fields += counted.fields;
        applied++;
    }
    expect(applied, `no extraction was applied over ${label}`).toBeGreaterThan(0);
    console.log(
        `[apply] ${label}: applied ${applied} extractions over ${containers} containers, ` +
            `re-resolved ${fields} fields, all unchanged`
    );
};
