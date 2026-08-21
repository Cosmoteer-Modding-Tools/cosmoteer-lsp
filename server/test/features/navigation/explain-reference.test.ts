import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, ValueNode, isValueNode } from '../../../src/core/ast/ast';
import { traceReference } from '../../../src/features/navigation/explain-reference/reference-trace';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { TemplateBaseIndex } from '../../../src/features/diagnostics/template-base.index';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';
import { FIXTURES_DIR, findReferenceNode, parseFixture, walkAst } from '../../helpers';

// The reference trace explains one reference path hop by hop: where it stopped, and what the game
// would really have found there. The shapes below are the ones a wrong answer would hurt on, so each
// is pinned to the exact hop it stops at, and the two refusals (`~` and `:`) are pinned to answering
// with no names and no correction at all.
const token = CancellationToken.None;
const TRACE_DIR = join(FIXTURES_DIR, 'reference-trace');

/** A token that reports itself cancelled from the start, for the give-up-early paths. */
const cancelledToken: CancellationToken = {
    isCancellationRequested: true,
    onCancellationRequested: () => ({ dispose: () => undefined }),
};

/** Traces the first reference written exactly like `reference` in `document`. */
const trace = (document: AbstractNodeDocument, reference: string) =>
    traceReference(findReferenceNode(document, reference), token);

/** Every reference value of a document. */
const referencesOf = function* (document: AbstractNodeDocument): Generator<ValueNode> {
    for (const node of walkAst(document)) {
        if (isValueNode(node) && node.valueType.type === 'Reference') yield node;
    }
};

describe('reference trace: where a path stops', () => {
    let shapes: AbstractNodeDocument;

    beforeAll(async () => {
        shapes = await parseFilePath(join(TRACE_DIR, 'shapes.rules'));
    });

    it('names the folder that was searched when the file itself is not there', async () => {
        const result = await trace(shapes, '&<missing.rules>/Anything');
        expect(result?.verdict).toBe('broken');
        expect(result?.failedAt).toBe(0);
        expect(result?.hops[0].kind).toBe('file');
        // The remaining segment was never looked up, which the report says rather than implying the
        // member is the problem.
        expect(result?.hops[1].reached).toBe(false);
        expect(result?.available).toEqual({ kind: 'file', directory: expect.stringContaining('reference-trace') });
    });

    it('walks through a file hop that does resolve', async () => {
        const result = await trace(shapes, '&<../colors.rules>/Black');
        expect(result?.verdict).toBe('resolved');
        expect(result?.hops.map((hop) => hop.kind)).toEqual(['file', 'member']);
        expect(result?.hops[1].landedOn?.uri).toContain('colors.rules');
    });

    it('reports the entry count for a list position past the end', async () => {
        const result = await trace(shapes, '&../Entries/5');
        expect(result?.verdict).toBe('broken');
        expect(result?.hops[2].kind).toBe('index');
        expect(result?.available).toEqual({ kind: 'entries', count: 2, incomplete: false });
        // A position is not a name, so nothing is offered as a correction.
        expect(result?.suggestion).toBeUndefined();
    });

    it('says a value has no members when a segment follows a scalar', async () => {
        const result = await trace(shapes, '&Kept/Deeper');
        expect(result?.verdict).toBe('broken');
        expect(result?.failedAt).toBe(1);
        expect(result?.available).toEqual({ kind: 'value', text: '1' });
    });

    it('counts the bases a container really declares for a base number out of range', async () => {
        const result = await trace(shapes, '&^/2/Kept');
        expect(result?.verdict).toBe('broken');
        expect(result?.failedAt).toBe(1);
        expect(result?.hops[1].kind).toBe('base');
        expect(result?.hops[1].baseCount).toBe(1);
        expect(result?.available).toEqual({ kind: 'bases', count: 1 });
    });

    it('offers the closest member of the scope the name was looked up in', async () => {
        const result = await trace(shapes, '&Etxra');
        expect(result?.verdict).toBe('broken');
        expect(result?.suggestion).toBe('Extra');
        expect(result?.correctedValue).toBe('&Extra');
        expect(result?.available.kind).toBe('members');
        // The fold is what the game reads, so the base's own member is on the list as inherited.
        const members = result?.available.kind === 'members' ? result.available.names : [];
        expect(members.find((member) => member.name === 'Kept')?.inherited).toBe(true);
        expect(members.find((member) => member.name === 'Extra')?.inherited).toBe(false);
    });

    it('labels a hop the inheritance chain supplies as inherited rather than as missing', async () => {
        const result = await trace(shapes, '&Kept');
        expect(result?.verdict).toBe('resolved');
        expect(result?.hops[0].inherited).toBe(true);
        expect(result?.hops[0].landedOn?.line).toBe(5);
    });

    it('says a segment kind it has no rule for is unmodelled instead of calling it a missing member', async () => {
        const result = await trace(shapes, '&../Base/./Kept');
        expect(result?.verdict).toBe('unmodelled-segment');
        expect(result?.hops[2].kind).toBe('unmodelled');
        expect(result?.suggestion).toBeUndefined();
    });

    it('says a base that does not declare the member is allowed rather than broken', async () => {
        // `Widen : ^/0/Widen` where the base has no Widen at all. The game reads that as the base
        // contributing nothing, so calling it broken would send an author after a non-problem.
        const result = await trace(shapes, '^/0/Widen');
        expect(result?.verdict).toBe('extends-missing-member');
        expect(result?.suggestion).toBeUndefined();
    });

    it('follows an alias and says which reference it followed', async () => {
        const chain = parseFixture('ref-chain.rules');
        const result = await trace(chain, '&Test1/TestValue');
        expect(result?.verdict).toBe('resolved');
        expect(result?.hops[0].aliasText).toBe('&TestBase');
        expect(result?.hops[0].landedKind).toBe('group');
        expect(result?.hops[1].landedKind).toBe('value');
    });

    it('tells an alias chain that comes back to itself apart from a name that is not there', async () => {
        const cycle = parseFixture('ref-cycle.rules');
        const result = await trace(cycle, '&A/x');
        expect(result?.verdict).toBe('cycle');
        expect(result?.hops[0].aliasBroken).toBe(true);
        // The member exists, so the members around it are not the answer and none of them is offered
        // as a correction.
        expect(result?.available).toEqual({ kind: 'alias', text: '&B', declaredAt: expect.anything() });
        expect(result?.suggestion).toBeUndefined();
    });

    it('gives up on a cancelled token instead of walking on', async () => {
        const result = await traceReference(findReferenceNode(shapes, '&Etxra'), cancelledToken);
        expect(result?.verdict).toBe('cancelled');
        expect(result?.hops.every((hop) => !hop.resolved)).toBe(true);
        expect(result?.available).toEqual({ kind: 'none' });
    });
});

describe('reference trace: the two shapes it refuses to judge', () => {
    const runtime = parseFixture('runtime-root-ref.rules');

    it('resolves a `~` path whose members this file really has', async () => {
        const result = await trace(runtime, '&~/RealRoot/Inner');
        expect(result?.verdict).toBe('resolved');
    });

    it('answers a `~` path into another object with no names and no correction', async () => {
        const result = await trace(runtime, '&~/EMITTER/BeamCount');
        expect(result?.verdict).toBe('runtime-only');
        expect(result?.available).toEqual({ kind: 'withheld', reason: 'runtime-root' });
        expect(result?.suggestion).toBeUndefined();
    });

    it('withholds the names even where the `~` root did lead somewhere real', async () => {
        // `RealRoot` is a group of this very file, so the walk gets one hop further. The names there
        // still belong to the file rather than to the object the game builds, so they stay unlisted.
        const result = await trace(runtime, '&~/RealRoot/Missing');
        expect(result?.verdict).toBe('runtime-only');
        expect(result?.failedAt).toBe(2);
        expect(result?.hops[1].landedKind).toBe('group');
        expect(result?.available).toEqual({ kind: 'withheld', reason: 'runtime-root' });
        expect(result?.suggestion).toBeUndefined();
    });

    it('never calls a `~` path broken, whatever it does', async () => {
        for (const reference of referencesOf(runtime)) {
            if (!String(reference.valueType.value).includes('~')) continue;
            const result = await traceReference(reference, token);
            expect(result?.verdict).not.toBe('broken');
        }
    });
});

describe('reference trace: virtual inheritance', () => {
    let virtual: AbstractNodeDocument;

    beforeAll(async () => {
        TemplateBaseIndex.instance.reset();
        await TemplateBaseIndex.instance.baseNames([TRACE_DIR], token);
        virtual = await parseFilePath(join(TRACE_DIR, 'virtual.rules'));
    });

    it('names the inheritor that supplies a member the base never declares', async () => {
        const result = await trace(virtual, '&../Parent/:/v_OnlyInChild');
        expect(result?.verdict).toBe('virtual');
        expect(result?.available).toEqual({ kind: 'withheld', reason: 'virtual' });
        expect(result?.suggestion).toBeUndefined();
        // Child writes v_OnlyInChild = 5 on line 12 (zero based 11).
        expect(result?.virtualTargets).toEqual([{ uri: expect.stringContaining('virtual.rules'), line: 11 }]);
    });

    it('names the deriving override beside the base declaration it resolves to', async () => {
        const result = await trace(virtual, '&../Parent/:/v_Foo');
        expect(result?.verdict).toBe('resolved');
        // The base's own v_Foo = 0 on line 6 is where the path lands.
        expect(result?.hops[3].landedOn?.line).toBe(5);
        // Child's v_Foo = 42 on line 11 is what the game reads when it builds a Child.
        expect(result?.virtualTargets).toEqual([{ uri: expect.stringContaining('virtual.rules'), line: 10 }]);
    });
});

describe('reference trace: inheritance references', () => {
    it('resolves a bare same-file base and does not report one hop as missing', async () => {
        const siblings = parseFixture('sibling-inheritance.rules');
        const result = await trace(siblings, '&BatteryStorageLeft');
        expect(result?.verdict).toBe('resolved');
        expect(result?.hops[0].resolved).toBe(true);
    });

    it('reads a numeric base entry as the list position it is', async () => {
        const numeric = parseFixture('numeric-inheritance.rules');
        const result = await trace(numeric, '&1');
        expect(result?.verdict).toBe('resolved');
        expect(result?.hops[0].kind).toBe('index');
    });

    it('agrees with the value validator on every reference of the inheritance fixtures', async () => {
        for (const fixture of ['inheritance.rules', 'sibling-inheritance.rules', 'numeric-inheritance.rules']) {
            const document = parseFixture(fixture);
            for (const reference of referencesOf(document)) {
                const result = await traceReference(reference, token);
                const finding = await ValidationForValue.callback(reference, token);
                expect([result?.verdict, String(reference.valueType.value)]).toEqual(['resolved', String(reference.valueType.value)]);
                expect(finding).toBeUndefined();
            }
        }
    });
});

describe('reference trace: a mod', () => {
    let consumer: AbstractNodeDocument;
    let manifest: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        consumer = await parseFilePath(join(FIXTURES_DIR, 'mod', 'consumer.rules'));
        manifest = await parseFilePath(join(FIXTURES_DIR, 'mod', 'mod.rules'));
    });

    it('reports a global only the mod inserts as resolved, not as broken', async () => {
        const result = await trace(consumer, '&/GLOBAL_TWO/Bar');
        expect(result?.verdict).toBe('resolved-via-mod');
        expect(result?.modOrigin?.uri).toContain('provider.rules');
        // The reference is fine, so nothing is listed as available and nothing is suggested.
        expect(result?.available).toEqual({ kind: 'none' });
        expect(result?.suggestion).toBeUndefined();
    });

    it('reports a member the mod merges into a game file as resolved through the mod', async () => {
        const result = await trace(consumer, '&/INDICATORS/SWNoShields');
        expect(result?.verdict).toBe('resolved-via-mod');
        expect(result?.modOrigin?.uri).toContain('mod_indicators.rules');
        // The hop before it is the game's own file, reached through the alias the global holds.
        expect(result?.hops[0].aliasText).toBe('&<indicators/indicators.rules>');
    });

    it('walks an action target from the game folder rather than from the manifest', async () => {
        const result = await trace(manifest, '<indicators/indicators.rules>');
        expect(result?.actionTarget).toBe(true);
        expect(result?.walked).toBe('<./Data/indicators/indicators.rules>');
        expect(result?.verdict).toBe('resolved');
    });

    it('follows an action target into what the mod itself adds', async () => {
        const result = await trace(manifest, '<cosmoteer.rules>/FOO');
        expect(result?.actionTarget).toBe(true);
        expect(result?.verdict).toBe('resolved-via-mod');
    });

    it('leaves a missing target alone when the action says it may be missing', async () => {
        // `CreateIfNotExisting = true` tells the game to create the target, so a target that is not
        // there is what the author asked for rather than a defect.
        const tolerant = await parseFilePath(join(FIXTURES_DIR, 'reference-trace-mod', 'mod.rules'));
        const result = await trace(tolerant, '<not_a_real_file.rules>');
        expect(result?.actionTarget).toBe(true);
        expect(result?.verdict).toBe('optional-target');
        expect(result?.suggestion).toBeUndefined();
    });
});
