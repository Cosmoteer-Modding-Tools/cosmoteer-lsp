import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { GroupNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { groupClassCandidates, memberTypeIn, resolveGroupClass } from '../../../src/document/schema/schema-context';
import { schemaFieldNameCompletions } from '../../../src/features/completion/autocompletion.schema-fields';
import { Completion } from '../../../src/features/completion/autocompletion.service';

// A wrapper class delegating its value form to a registry (`[Serialize(Alias="")]` on a polymorphic
// member) reads both its own fields and the dispatched member's, written flat in one group. The
// class resolution stays single-valued (whichever side owns more written names wins), so the losing
// side's fields must stay reachable through the delegation companion, or they go dark: the music
// FSM's `FsmState` wrapper (CueCondition/MaxConsecutivePlays/NextTracks) around a MusicTrackRules
// member is the offline-testable shape of the stat-widget/brush wrappers.
const token = CancellationToken.None;
const WRAPPER = 'Cosmoteer.Music.MusicFsmTrackRules/FsmState';
const MEMBER = 'Cosmoteer.Music.MusicLayersTrackRules';
const parse = (src: string) => parser(lexer(src), 'file:///data/music/t.rules').value;
const labelsOf = (cs: Completion[]) => cs.map((c) => (typeof c === 'string' ? c : c.label));

/**
 * Finds the first element group of the document's top-level `IntroTracks` list.
 * @param doc the parsed document to search
 * @returns the first group element of the `IntroTracks` list
 */
const firstIntroTrack = (doc: ReturnType<typeof parse>): GroupNode => {
    const list = doc.elements.find((e) => isListNode(e) && e.identifier?.name === 'IntroTracks');
    expect(list, 'IntroTracks list').toBeDefined();
    const element = (list as unknown as { elements: unknown[] }).elements.find((e) => isGroupNode(e as GroupNode));
    expect(element, 'IntroTracks element group').toBeDefined();
    return element as GroupNode;
};

// The member side owns more written names (Layers on the member, Loop on its base), so it wins the
// single-valued pick and the wrapper becomes the companion.
const MEMBER_HEAVY = [
    'Type = FSM',
    'IntroTracks',
    '[',
    '\t{',
    '\t\tType = Layers',
    '\t\tLoop = true',
    '\t\tLayers',
    '\t\t[',
    '\t\t]',
    '\t\tNextTracks',
    '\t\t[',
    '\t\t]',
    '\t}',
    ']',
    '',
].join('\n');

// The wrapper side owns every written name, so it wins and the member becomes the companion.
const WRAPPER_HEAVY = [
    'Type = FSM',
    'IntroTracks',
    '[',
    '\t{',
    '\t\tType = Layers',
    '\t\tMaxConsecutivePlays = 2',
    '\t\tNextTracks',
    '\t\t[',
    '\t\t]',
    '\t}',
    ']',
    '',
].join('\n');

describe('wrapper-delegation class candidates', () => {
    it('yields the dispatched member first and the wrapper as companion when the member wins', () => {
        const element = firstIntroTrack(parse(MEMBER_HEAVY));
        expect(resolveGroupClass(element)).toBe(MEMBER);
        expect(groupClassCandidates(element)).toEqual([MEMBER, WRAPPER]);
    });

    it('yields the wrapper first and the member as companion when the wrapper wins', () => {
        const element = firstIntroTrack(parse(WRAPPER_HEAVY));
        expect(resolveGroupClass(element)).toBe(WRAPPER);
        expect(groupClassCandidates(element)).toEqual([WRAPPER, MEMBER]);
    });

    it('types the losing side members through the companion', () => {
        // Member primary: the wrapper's NextTracks still types.
        const memberHeavy = firstIntroTrack(parse(MEMBER_HEAVY));
        expect(memberTypeIn(memberHeavy, 'NextTracks')?.kind).toBe('list');
        expect(memberTypeIn(memberHeavy, 'Layers')?.kind).toBe('list');
        // Wrapper primary: the member's Layers still types.
        const wrapperHeavy = firstIntroTrack(parse(WRAPPER_HEAVY));
        expect(memberTypeIn(wrapperHeavy, 'Layers')?.kind).toBe('list');
        expect(memberTypeIn(wrapperHeavy, 'NextTracks')?.kind).toBe('list');
    });

    it('offers the fields of both sides in completion, deduped', async () => {
        const offset = MEMBER_HEAVY.indexOf('Loop = true');
        const labels = labelsOf(await schemaFieldNameCompletions(parse(MEMBER_HEAVY), offset, token));
        // CueCondition lives on the wrapper, DebugName on the member's base class.
        expect(labels).toContain('CueCondition');
        expect(labels).toContain('DebugName');
        expect(labels.length).toBe(new Set(labels).size);
    });
});
