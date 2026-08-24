/**
 * Counts how often the game's own files write each field of each schema class, and writes the
 * table the field-name completion ranks by.
 *
 * A class such as `PartRules` declares over a hundred fields, and the completion list sorted them
 * required-first and then alphabetically, which puts the fields an author reaches for every day
 * behind ones the game itself never writes. Counting the shipped data answers which is which, and
 * the answer only changes when the game does.
 *
 * Run it with the game installed:
 *
 *     npm run fieldstats
 *
 * The table lands in `server/src/features/completion/field-usage.json`, deliberately on the
 * completion side of the tree: the cache build id is seeded from the parsing and validation
 * directories, so a regenerated table there would discard every user's on-disk caches on upgrade
 * for a change no cached answer depends on.
 *
 * The counts carry the base game's bias, which is the point: they rank a list, and nothing else
 * reads them. A field the count has never seen keeps its alphabetical place rather than being
 * pushed down.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNode, isAssignmentNode, isGroupNode, isListNode } from '../../server/src/core/ast/ast';
import { lexer } from '../../server/src/core/lexer/lexer';
import { parser } from '../../server/src/core/parser/parser';
import { resolveGroupClass } from '../../server/src/document/schema/schema-context';
import { documentRootClass } from '../../server/src/document/schema/document-root';
import { fieldOf } from '../../server/src/document/schema/schema';
import { ParserResultRegistrar } from '../../server/src/registrar/parser-result-registrar';
import { globalSettings } from '../../server/src/settings';
import { CosmoteerWorkspaceService } from '../../server/src/workspace/cosmoteer-workspace.service';

const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const OUT_FILE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'server',
    'src',
    'features',
    'completion',
    'field-usage.json'
);

/** Every `.rules` file under a folder, in walk order. */
const rulesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            let stats;
            try {
                stats = statSync(path);
            } catch {
                continue;
            }
            if (stats.isDirectory()) walk(path);
            else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
        }
    };
    walk(root);
    return out;
};

/** class FullName to field name to how many times the game's files write it. */
const counts = new Map<string, Map<string, number>>();

/** Records one written member against the class the group it sits in resolved to. */
const record = (cls: string, name: string): void => {
    if (!fieldOf(cls, name)) return;
    const fields = counts.get(cls) ?? counts.set(cls, new Map()).get(cls)!;
    fields.set(name, (fields.get(name) ?? 0) + 1);
};

/** Walks a node, counting the members of every group whose class resolves. */
const visit = (node: AbstractNode, rootClass: string | undefined): void => {
    if (isGroupNode(node)) {
        const cls = resolveGroupClass(node);
        if (cls) {
            for (const element of node.elements) {
                if (isAssignmentNode(element)) record(cls, element.left.name);
                else if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
                    record(cls, element.identifier.name);
                }
            }
        }
    }
    const children = isGroupNode(node) || isListNode(node) ? node.elements : [];
    for (const child of children) visit(child, rootClass);
    if (isAssignmentNode(node) && node.right) visit(node.right, rootClass);
};

const main = async (): Promise<void> => {
    globalSettings.cosmoteerPath = DATA_DIR;
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    await service.initialize(DATA_DIR, noop);
    void CancellationToken.None;

    const files = rulesUnder(DATA_DIR);
    let scanned = 0;
    for (const file of files) {
        let document;
        try {
            document = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
        } catch {
            continue;
        }
        const rootClass = documentRootClass(document);
        if (rootClass) {
            for (const element of document.elements) {
                if (isAssignmentNode(element)) record(rootClass, element.left.name);
                else if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
                    record(rootClass, element.identifier.name);
                }
            }
        }
        for (const element of document.elements) visit(element, rootClass);
        if (++scanned % 200 === 0) ParserResultRegistrar.instance.clear();
    }

    const table: Record<string, Record<string, number>> = {};
    for (const [cls, fields] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
        // Only the order matters downstream, so a field written once carries as much information
        // as one written a thousand times and the file stays diffable.
        const sorted = [...fields].sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB));
        table[cls] = Object.fromEntries(sorted);
    }
    writeFileSync(OUT_FILE, `${JSON.stringify(table, null, 1)}\n`, 'utf8');
    console.log(`scanned ${scanned} files, ${Object.keys(table).length} classes -> ${OUT_FILE}`);
};

await main();
