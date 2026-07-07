import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, isAssignmentNode, isDocumentNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { resolveGroupClass } from '../../../src/document/schema/schema-context';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { fieldOf, isShaderConstantField, registryOf } from '../../../src/document/schema/schema';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';

// Whole-dataset exercise of the schema against the game's own `Data/**/*.rules` — the ground truth
// for both halves of the feature:
//   1. TYPE VALIDATION: validateSchema over every vanilla file must produce ZERO warnings (every
//      warning on shipping data is a false positive — the game loads all of it).
//   2. AUTOCOMPLETION COVERAGE: for every group whose class we resolve, what fraction of the fields
//      vanilla actually writes does the schema recognize (`fieldOf`)? That is exactly the set
//      field-name completion would offer, so the recognition rate is the completion coverage.
// Needs the game install, so it self-skips when Data/ is absent (e.g. CI). Point it elsewhere with
// COSMOTEER_DATA_DIR. The `Type=` discriminator is excluded from the denominator: it is the registry
// selector (validated separately), never a `fieldOf` member, so counting it would understate coverage.
const DATA_DIR =
    process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

// A regression floor for field-name recognition over all of vanilla (measured ~98.6% after, on top of
// the earlier modelling, recognizing `[Serialize(AlternateAliases=…)]` field spellings and rooting the
// spawner-generator files — sectors via the `SimObjectSpawner` registry and the `&<>`-included
// `SimulationGenerator`/`GalaxyGenerator` fragments — so their sub-spawners resolve within the spawner
// registry instead of the colliding doodad one. Most of the residual ~1.4% is dead copy-paste fields
// in vanilla particle updaters that the engine ignores. A drop means a regeneration dropped fields or a
// whole type went unmodelled — investigate the printed gap report.
// Lowered from 0.98 with the value-form delegation work (measured 97.5%): media/hit-effect list
// elements now resolve at all, so they entered the denominator, and the ones written as anonymous
// `: /BASE_SOUNDS/AudioInterior { … }` inheritors carry their concrete type in a cross-file base
// this standalone scan cannot follow. They resolve to the registry base here (its own fields
// count as unknown) while the editor's inheritance-aware paths resolve the full class.
const MIN_RECOGNITION = 0.97;

const rulesFiles = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

const isDiscriminator = (cls: string, name: string): boolean => name === (registryOf(cls)?.typeField ?? 'Type');

describe.skipIf(!HAVE_DATA)('schema coverage over vanilla Data', () => {
    const files = HAVE_DATA ? rulesFiles(DATA_DIR) : [];

    it('produces ZERO validation warnings across every vanilla file (no false positives)', async () => {
        const offenders: string[] = [];
        for (const file of files) {
            let doc;
            try {
                doc = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
            } catch {
                continue; // parser robustness is covered elsewhere; this test is about schema warnings
            }
            const errors = await validateSchema(doc, token);
            if (errors.length) offenders.push(`${file}: ${errors.map((e) => e.message).join(' | ')}`);
        }
        expect(offenders.slice(0, 30)).toEqual([]);
        // Whole-dataset scan: well under a second alone, but the default 5s can trip under
        // full-suite CPU contention, so it gets the same explicit budget as the other scans.
    }, 600_000);

    it('recognizes at least 90% of the fields vanilla actually writes (completion coverage)', async () => {
        let known = 0;
        let unknown = 0;
        const gaps = new Map<string, number>();
        let completionRuns = 0;

        const countField = (cls: string, name: string): void => {
            if (isDiscriminator(cls, name)) return;
            // A real schema field, or an open-ended `_`-prefixed shader constant on a material/sprite.
            if (fieldOf(cls, name) || isShaderConstantField(cls, name)) known++;
            else {
                unknown++;
                const key = `${cls.split('.').pop()}.${name}`;
                gaps.set(key, (gaps.get(key) ?? 0) + 1);
            }
        };

        for (const file of files) {
            let doc;
            try {
                doc = parser(lexer(readFileSync(file, 'utf8')), pathToFileURL(file).href).value;
            } catch {
                continue;
            }
            const rootClass = documentRootClass(doc);
            if (rootClass) {
                for (const el of doc.elements) if (isAssignmentNode(el)) countField(rootClass, el.left.name);
            }
            const visit = (node: AbstractNode): void => {
                if (isGroupNode(node)) {
                    const cls = resolveGroupClass(node);
                    if (cls) {
                        for (const el of node.elements) if (isAssignmentNode(el)) countField(cls, el.left.name);
                        // Smoke-test the actual completion pipeline on real data (must not throw).
                        if (completionRuns < 300) {
                            completionRuns++;
                            void schemaFieldNameCompletions(doc, node.position.start + 1, token);
                        }
                    }
                }
                const kids: AbstractNode[] =
                    isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                        ? node.elements
                        : isAssignmentNode(node)
                          ? [node.right]
                          : [];
                for (const k of kids) if (k) visit(k);
            };
            for (const el of doc.elements) visit(el);
        }

        const recognition = known / (known + unknown);
        const topGaps = [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
        // Surfaced on the test report so a coverage regression names the offending fields.
        console.log(
            `\n[schema coverage] ${files.length} files — recognition ${(recognition * 100).toFixed(1)}% ` +
                `(${known} known / ${unknown} unknown)\n` +
                topGaps.map(([k, c]) => `  ${c}x ${k}`).join('\n')
        );
        expect(recognition).toBeGreaterThanOrEqual(MIN_RECOGNITION);
    }, 600_000);
});
