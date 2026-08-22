import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { Completion, CompletionSuggestion } from '../../../src/features/completion/autocompletion.service';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import {
    NO_INHERITED_MEMBERS,
    inheritedMembersFor,
} from '../../../src/features/completion/inherited-members';
import { validateRequiredFields } from '../../../src/features/diagnostics/validator.required-fields';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

// Field-name completion inside a group that inherits has to say which names the chain already
// supplies and what it supplies for them, instead of offering them as if nothing had set them. The
// cases below are the shapes the game's own data is written in: a caret base (`X : ^/0/X`), a plain
// cross-file base, a whole-file base, and several bases at once. The two refusals are pinned as
// hard as the annotations, since an annotation naming the wrong file is worse than none.
const token = CancellationToken.None;

beforeAll(async () => {
    await initWorkspace();
});

/** Parse a source under a real fixture path, so `<./Data/…>` and `/MACRO` bases resolve on disk. */
const parseAt = (src: string, ...segments: string[]): AbstractNodeDocument =>
    parser(lexer(src), workspaceFile(...(segments.length > 0 ? segments : ['parts', 'probe.rules'])).replace(/\\/g, '/'))
        .value;

/** The named group anywhere in a parsed document. */
const groupNamed = (document: AbstractNodeDocument, name: string): GroupNode => {
    const search = (node: AbstractNode): GroupNode | undefined => {
        if (isGroupNode(node) && node.identifier?.name === name) return node;
        for (const child of isGroupNode(node) || isListNode(node) ? node.elements : []) {
            const hit = search(child);
            if (hit) return hit;
        }
        return undefined;
    };
    for (const element of document.elements) {
        const hit = search(element);
        if (hit) return hit;
    }
    throw new Error(`no group named ${name}`);
};

/** The suggestion offered under `label`, which must be there. */
const itemNamed = (completions: Completion[], label: string): CompletionSuggestion => {
    const found = completions.find((completion) => typeof completion !== 'string' && completion.label === label);
    expect(found, `no completion labelled ${label}`).toBeDefined();
    return found as CompletionSuggestion;
};

/** Field-name completion at the `@@` marker of a source. */
const completeAtMarker = async (src: string, ...segments: string[]): Promise<Completion[]> =>
    schemaFieldNameCompletions(parseAt(src, ...segments), src.indexOf('@@'), token);

// A caret base is the shape most of the game's own data uses and the one the older
// `<file>`-only reader could never follow, so it is the first thing pinned.
const CARET_BASE = [
    'Part : &<./Data/parts/base_part.rules>/Part',
    '{',
    '\tComponents : ^/0/Components',
    '\t{',
    '\t\tIsOperational : ^/0/IsOperational',
    '\t\t{',
    '\t\t\t@@',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

describe('field completion inside a group that inherits', () => {
    it('names the base file and the value it supplies, through a caret base', async () => {
        const items = await completeAtMarker(CARET_BASE);
        const mode = itemNamed(items, 'Mode');
        expect(mode.detail).toContain('inherited from base_part.rules');
        expect(mode.documentation).toContain('Mode = `All` in base_part.rules:12');
    });

    it('offers the inherited field below the ones nothing has set', async () => {
        const items = await completeAtMarker(CARET_BASE);
        expect(itemNamed(items, 'Mode').sortText).toBe('2_Mode');
        // A field the chain does not supply keeps the ordering it always had.
        expect(itemNamed(items, 'Invert').sortText).toBe('1_Invert');
    });

    it('marks the Type discriminator the base supplies, and still offers it', async () => {
        const items = await completeAtMarker(CARET_BASE);
        const type = itemNamed(items, 'Type');
        expect(type.detail).toContain('inherited from base_part.rules');
        expect(type.documentation).toContain('Type = `MultiToggle` in base_part.rules:11');
        // Overriding a base's `Type` in a deriving group is legal, so it stays on offer, but it no
        // longer sits above every other field as though the group had yet to choose a subtype.
        expect(type.sortText).toBe('2_Type');
    });

    it('marks a field a plain cross-file base supplies', async () => {
        const src = 'Part : &<./Data/parts/base_part.rules>/Part\n{\n\t@@\n}\n';
        const components = itemNamed(await completeAtMarker(src), 'Components');
        expect(components.detail).toContain('inherited from base_part.rules');
        expect(components.documentation).toContain('base_part.rules:7');
    });

    it('marks a field a whole-file base supplies', async () => {
        // `MyShake : /BASE_SHAKE` inherits a rootless fragment whose top level is the group body, so
        // the members come from the base file's root rather than from a named group in it.
        const src = 'MyShake : /BASE_SHAKE\n{\n\t@@\n}\n';
        const items = await completeAtMarker(src, 'effects', 'probe.rules');
        const falloff = itemNamed(items, 'DurationFalloff');
        expect(falloff.detail).toContain('inherited from base_shake.rules');
        expect(falloff.documentation).toContain('DurationFalloff = `2` in base_shake.rules:5');
    });

    it('marks a name the user has finished typing, which the popup still offers', async () => {
        // A fully typed field name is a member of this group, so the chain reports the local
        // declaration and parks the base's under it. That is exactly the moment the user needs to be
        // told the base already writes it.
        const src = [
            'Part : &<./Data/parts/base_part.rules>/Part',
            '{',
            '\tComponents : ^/0/Components',
            '\t{',
            '\t\tIsOperational : ^/0/IsOperational',
            '\t\t{',
            '\t\t\tMode',
            '\t\t}',
            '\t}',
            '}',
            '',
        ].join('\n');
        const items = await schemaFieldNameCompletions(parseAt(src), src.indexOf('Mode') + 4, token);
        expect(itemNamed(items, 'Mode').documentation).toContain('Mode = `All` in base_part.rules:12');
    });

    it('names the first base when two of them write the same field', async () => {
        // The game's lookup takes the first hit, so the first base written is the one that supplies
        // the value, and the later one is hidden.
        const src = [
            'BaseOne',
            '{',
            '\tDensity = 1',
            '}',
            'BaseTwo',
            '{',
            '\tDensity = 2',
            '}',
            'Thing : &BaseOne',
            '&BaseTwo',
            '{',
            '}',
            '',
        ].join('\n');
        const document = parseAt(src);
        const supplied = await inheritedMembersFor(groupNamed(document, 'Thing'), token);
        expect(supplied.get('density')?.value).toBe('`1`');
        expect(supplied.get('density')?.line).toBe(3);
    });
});

describe('what field completion refuses to say about a chain', () => {
    it('says nothing at all when a base could not be followed', async () => {
        const src = 'Part : &NoSuchBase\n{\n\t@@\n}\n';
        const items = await completeAtMarker(src);
        // The fields are still offered, exactly as before the annotation existed. Only the claim
        // about where a value comes from is withheld.
        expect(items.length).toBeGreaterThan(20);
        expect(items.filter((item) => typeof item !== 'string' && item.detail?.includes('inherited from'))).toEqual([]);
    });

    it('trusts a `~` base inside the file that writes it', async () => {
        // A part reaching its own `~/OVERCLOCK` block is the shape the game's own weapons are written
        // in, and the members it reaches really are declared in this file.
        const src = ['OVERCLOCK', '{', '\tBEAM', '\t{', '\t\tDensity = 1', '\t}', '}', 'Thing : ~/OVERCLOCK/BEAM', '{', '}', ''].join('\n');
        const supplied = await inheritedMembersFor(groupNamed(parseAt(src), 'Thing'), token);
        expect(supplied.get('density')?.value).toBe('`1`');
    });

    it('says nothing about a `~` base whose path leaves the file writing it', async () => {
        // `~` is the root of wherever the rule is instantiated, so once the path steps out of this
        // file there is no telling which file the game ends up reading the member from.
        const src = [
            'Part : &<./Data/parts/base_part.rules>/Part',
            '{',
            '\tThing : ~/Part/^/0/Components',
            '\t{',
            '\t}',
            '}',
            '',
        ].join('\n');
        expect(await inheritedMembersFor(groupNamed(parseAt(src), 'Thing'), token)).toEqual(NO_INHERITED_MEMBERS);
    });

    it('does not walk anything for a group that inherits nothing', async () => {
        const document = parseAt('Thing\n{\n\tDensity = 1\n}\n');
        expect(await inheritedMembersFor(groupNamed(document, 'Thing'), token)).toBe(NO_INHERITED_MEMBERS);
    });

    it('does not walk anything once the request is cancelled', async () => {
        const document = parseAt('Base\n{\n\tDensity = 1\n}\nThing : &Base\n{\n}\n');
        const cancelled = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) };
        expect(await inheritedMembersFor(groupNamed(document, 'Thing'), cancelled)).toBe(NO_INHERITED_MEMBERS);
    });
});

describe('the aggregate required-fields pick inside a group that inherits', () => {
    // A turret needs FiringArc, RotateSpeed, FireThresholdAngle and FireInterval. The base writes two
    // of them, so scaffolding all four would write two overrides that change nothing.
    const TURRET = [
        'Part',
        '{',
        '\tComponents',
        '\t{',
        '\t\tTurretBase',
        '\t\t{',
        '\t\t\tType = TurretWeapon',
        '\t\t\tFiringArc = 90d',
        '\t\t\tRotateSpeed = 1',
        '\t\t}',
        '\t\tMyTurret : &TurretBase',
        '\t\t{',
        '\t\t\tType = TurretWeapon',
        '\t\t\t@@',
        '\t\t}',
        '\t}',
        '}',
        '',
    ].join('\n');

    it('scaffolds only the required fields the chain does not already supply', async () => {
        const aggregate = itemNamed(await completeAtMarker(TURRET), 'Insert 2 required fields');
        expect(aggregate.detail).toBe('FireThresholdAngle, FireInterval');
        expect(aggregate.insertText).not.toContain('FiringArc');
        expect(aggregate.insertText).not.toContain('RotateSpeed');
    });

    it('offers the same set the required-field check reports as missing', async () => {
        const document = parseAt(TURRET);
        const reported = (await validateRequiredFields(document, token)).map((error) =>
            /'([^']+)'/.exec(error.message)?.[1]
        );
        const aggregate = itemNamed(await schemaFieldNameCompletions(document, TURRET.indexOf('@@'), token), 'Insert 2 required fields');
        expect(aggregate.detail?.split(', ')).toEqual(reported);
    });
});
