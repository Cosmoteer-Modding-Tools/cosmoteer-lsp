import { describe, expect, it } from 'vitest';
import { isGroupNode } from '../../../../src/core/ast/ast';
import { parseText } from '../../../../src/utils/ast.utils';
import { judgeContainer } from '../../../../src/features/refactor/shared-base/extractability';
import {
    AnalysisFile,
    buildExtractionPlans,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';

// One case per reason a member is left where the author wrote it. Every case is the same three part
// files, agreeing on Density and IsRotateable so a plan always forms, plus the one member under
// test written identically in all three. A member that still ends up in `plan.fields` would be
// moved into a base file the game reads differently, so each case asserts its absence there rather
// than asserting an intermediate verdict.
const PARTS_DIR = 'C:/mod/parts';
const ANCHOR_DIR = 'C:/mod';

const filesWith = (extra: string): AnalysisFile[] =>
    ['a', 'b', 'c'].map((suffix) => {
        const text = `Part\n{\n\tID = test.part_${suffix}\n\tDensity = 3\n\tIsRotateable = false\n${extra}}\n`;
        const fsPath = `${PARTS_DIR}/part_${suffix}.rules`;
        return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
    });

/**
 * The fields the extraction would move out of three files that carry `extra` verbatim.
 *
 * @param extra the member source appended to each file's `Part` group, indented and newline
 * terminated.
 * @returns the planned field keys, asserting first that a plan formed at all so a case can never
 * pass by refusing the whole container.
 */
const fieldsWith = (extra: string): string[] => {
    const plans = buildExtractionPlans(filesWith(extra), { anchorDir: ANCHOR_DIR });
    expect(plans).toHaveLength(1);
    expect(plans[0].fields).toContain('density');
    expect(plans[0].fields).toContain('isrotateable');
    return plans[0].fields;
};

/** The `Part` group of a single file, for the container-level judgement. */
const containerOf = (text: string) => {
    const document = parseText(text, `${PARTS_DIR}/part_a.rules`);
    const group = document.elements.find(isGroupNode);
    if (!group) throw new Error('the fixture text parsed without a Part group');
    return { group, text };
};

describe('shared base extraction refuses a member', () => {
    it('refuses a field the schema declares as a list', () => {
        // An inherited list is prepended to the deriver's own, so moving one shifts every index a
        // reference addresses.
        expect(fieldsWith('\tSelectionTypeRotations = [0, 2]\n')).not.toContain('selectiontyperotations');
    });

    it('refuses a member written in list form', () => {
        expect(fieldsWith('\tSelectionTypeRotations [0, 2]\n')).not.toContain('selectiontyperotations');
    });

    it('refuses a group that holds a list', () => {
        expect(fieldsWith('\tCrewSpeedFactor\n\t{\n\t\tForward [1, 2]\n\t}\n')).not.toContain('crewspeedfactor');
    });

    it('refuses the Type discriminator', () => {
        // Moving `Type` cross-file blinds completion, hover and validation for the whole group.
        expect(fieldsWith('\tType = NotARealTypeAtAll\n')).not.toContain('type');
    });

    it('refuses an identity field', () => {
        expect(fieldsWith('\tNameKey = "Parts/Shared"\n')).not.toContain('namekey');
    });

    it('refuses a field the schema class does not declare', () => {
        expect(fieldsWith('\tNotAFieldAtAll = 2\n')).not.toContain('notafieldatall');
    });

    it('refuses a field the engine no longer reads', () => {
        // FireDamageFactor is on PartRules but marked dead, so moving it would rewrite two files
        // for a value the game ignores.
        expect(fieldsWith('\tFireDamageFactor = 2\n')).not.toContain('firedamagefactor');
    });

    it('refuses a field a comment sits inside', () => {
        expect(fieldsWith('\tConstructionWork = /* tuned by hand */ 5\n')).not.toContain('constructionwork');
    });

    it('refuses a field with a trailing comment, which no longer owns its line', () => {
        expect(fieldsWith('\tConstructionWork = 5 // tuned by hand\n')).not.toContain('constructionwork');
    });

    it('refuses a field a banner comment on the line above introduces', () => {
        // The gap in front of a member belongs to it: moving the field would leave the note behind
        // explaining a line that is no longer there.
        expect(fieldsWith('\t// tuned by hand\n\tConstructionWork = 5\n')).not.toContain('constructionwork');
    });

    it('refuses a field written as an assigned list, not only the bare list form', () => {
        // An inherited list is prepended to the deriver's own, so a moved one shifts every index a
        // reference addresses. Both spellings have to be refused, and the assigned one wraps the
        // list in an assignment where a node-shape check alone does not see it.
        expect(fieldsWith('\tRoofDecalSize = [1, 2]\n')).not.toContain('roofdecalsize');
    });

    it('refuses both fields that share one line', () => {
        const fields = fieldsWith('\tConstructionWork = 5, IsCrewSalvageable = true\n');
        expect(fields).not.toContain('constructionwork');
        expect(fields).not.toContain('iscrewsalvageable');
    });

    it('refuses a field the file itself reads by reference', () => {
        // The constant idiom: another member computes from this one by name, which a base file
        // would not answer the same way.
        const fields = fieldsWith('\tConstructionWork = 5\n\tAIValueFactor = (&ConstructionWork) * 2\n');
        expect(fields).not.toContain('constructionwork');
    });

    it('refuses a value that starts at the runtime root with ~', () => {
        expect(fieldsWith('\tConstructionWork = &~/Components/Reactor/Power\n')).not.toContain('constructionwork');
    });

    it('refuses a value that indexes the inheritance list with ^', () => {
        expect(fieldsWith('\tConstructionWork = &^/0/AIValueFactor\n')).not.toContain('constructionwork');
    });

    it('refuses a value that walks the declaring scope with a bare &Name', () => {
        expect(fieldsWith('\tConstructionWork = &BUILD_WORK\n')).not.toContain('constructionwork');
    });

    it('refuses a value that selects an inheritor with a virtual colon', () => {
        expect(fieldsWith('\tConstructionWork = (&:/MaxHealth)\n')).not.toContain('constructionwork');
    });
});

describe('shared base extraction refuses a container', () => {
    it('refuses a container that lists more than one base', () => {
        // An earlier base overrides a later one, so inserting one at the front re-prioritizes every
        // field the container already inherits.
        const { group, text } = containerOf(
            'Part : <../base_part.rules>/Part, <../base_hull.rules>/Part\n{\n\tDensity = 3\n}\n'
        );
        expect(judgeContainer(group, text)).toBe('multipleBases');
    });

    it('refuses a container that addresses an inheritance slot past the first', () => {
        // Inserting a base renumbers every later slot, so `^/1` would silently point elsewhere.
        const { group, text } = containerOf('Part\n{\n\tConstructionWork = &^/1/AIValueFactor\n}\n');
        expect(judgeContainer(group, text)).toBe('laterInheritanceSlot');
    });

    it('refuses a container whose schema class does not resolve', () => {
        const { group, text } = containerOf('Whatever\n{\n\tDensity = 3\n}\n');
        expect(judgeContainer(group, text)).toBe('noClass');
    });

    it('accepts a plain part container and reports its class', () => {
        const { group, text } = containerOf('Part\n{\n\tDensity = 3\n}\n');
        const facts = judgeContainer(group, text);
        expect(typeof facts).not.toBe('string');
        expect(facts).toMatchObject({ className: 'Cosmoteer.Ships.Parts.PartRules' });
    });
});
