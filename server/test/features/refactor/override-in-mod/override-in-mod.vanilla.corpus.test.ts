import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { AbstractNode, AbstractNodeDocument } from '../../../../src/core/ast/ast';
import { isTypableTargetPath } from '../../../../src/mod/action-rooting.index';
import {
    OverrideRefusal,
    overrideMemberAt,
} from '../../../../src/features/refactor/override-in-mod/override-member';
import { memberSpanOf } from '../../../../src/features/refactor/shared-base/member-record';
import { memberNameOf } from '../../../../src/semantics/reference-resolver';
import { parseText } from '../../../../src/utils/ast.utils';

// The generator run over the game's own data. What it writes goes into somebody's mod and is applied
// to the install at load time, so the three properties that make it safe are proved against the real
// tree rather than against fixtures: the target is always a path the game addresses by plain member
// names, the body is always exactly one member deep, and every refusal falls in an enumerated class.
const DATA_DIR = (process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data')
    .replace(/\\/g, '/');
const HAVE = existsSync(DATA_DIR);
// The whole tree takes minutes, because judging a member's paths stats each of them. A sample is
// walked by default and the full tree is asked for with the environment variable.
const SAMPLE = Number(process.env.OVERRIDE_CORPUS_FILES ?? '200');

/** Every refusal the generator is allowed to answer with. */
const KNOWN_REFUSALS: OverrideRefusal[] = [
    'stale',
    'insideList',
    'indexSegment',
    'unnamedMember',
    'shadowedName',
    'emptyMember',
    'inheritedMember',
    'multiLineText',
    'scopeRelativeValue',
    'unrebasablePath',
    'untypablePath',
];

/** Every `.rules` file under a root, in directory order. */
const rulesFilesUnder = (root: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(root)) {
        if (entry.startsWith('.')) continue;
        const path = join(root, entry).replace(/\\/g, '/');
        if (statSync(path).isDirectory()) rulesFilesUnder(path, out);
        else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
    }
    return out;
};

/** Every offset that names a member, at every depth of a document. */
const memberOffsets = (node: AbstractNode, out: number[] = []): number[] => {
    const elements = (node as { elements?: AbstractNode[] }).elements;
    if (!elements) return out;
    for (const element of elements) {
        // An assignment carries no position of its own, which is exactly why the span helper exists.
        const span = memberSpanOf(element);
        if (span && memberNameOf(element) !== undefined) out.push(span.start);
        const value = (element as { right?: AbstractNode }).right ?? element;
        memberOffsets(value, out);
    }
    return out;
};

/** The counts one run produces, so a regression reads as a number rather than as a stack. */
interface Tally {
    files: number;
    emitted: number;
    refusals: Map<string, number>;
    bad: string[];
}

describe.skipIf(!HAVE)('overrides generated over the game data tree', () => {
    it('emits only addressable targets and one-level bodies, and refuses for known reasons', () => {
        const all = rulesFilesUnder(DATA_DIR);
        expect(all.length).toBeGreaterThan(500);
        const step = Math.max(1, Math.floor(all.length / SAMPLE));
        const files = all.filter((_, index) => index % step === 0);

        const result: Tally = { files: 0, emitted: 0, refusals: new Map(), bad: [] };
        for (const path of files) {
            let text: string;
            let document: AbstractNodeDocument;
            try {
                text = readFileSync(path, 'utf8');
                document = parseText(text, path);
            } catch {
                continue;
            }
            result.files++;
            for (const offset of memberOffsets(document)) {
                const outcome = overrideMemberAt(document, text, offset, path, DATA_DIR);
                if ('refusal' in outcome) {
                    result.refusals.set(outcome.refusal, (result.refusals.get(outcome.refusal) ?? 0) + 1);
                    if (!KNOWN_REFUSALS.includes(outcome.refusal) && result.bad.length < 20) {
                        result.bad.push(`${path}: unknown refusal ${outcome.refusal}`);
                    }
                    continue;
                }
                result.emitted++;
                const member = outcome.member;
                if (!isTypableTargetPath(member.target) && result.bad.length < 20) {
                    result.bad.push(`${path}: untypable target ${member.target}`);
                }
                if (/\/\d+(\/|$)/.test(member.target) && result.bad.length < 20) {
                    result.bad.push(`${path}: index segment in ${member.target}`);
                }
                // The body is read back the way the game reads the map: exactly one entry, keyed by
                // the member the caret was on. A second entry would change a member nobody asked
                // about, and a nested body would replace everything under the node it nests through.
                const entries = parseText(`${member.body}\n`, path).elements.filter(
                    (element) => memberNameOf(element) !== undefined
                );
                if (entries.length !== 1 && result.bad.length < 20) {
                    result.bad.push(`${path}: ${entries.length} entries in the body of ${member.name}`);
                } else if (memberNameOf(entries[0]) !== member.name && result.bad.length < 20) {
                    result.bad.push(`${path}: body of ${member.name} keys ${memberNameOf(entries[0])}`);
                }
            }
        }

        console.log(
            `override generator: ${result.files} files, ${result.emitted} overrides emitted, ` +
                `refusals ${[...result.refusals].map(([reason, count]) => `${reason}=${count}`).join(' ')}`
        );
        expect(result.bad).toEqual([]);
        expect(result.emitted).toBeGreaterThan(0);
    }, 600_000);
});
