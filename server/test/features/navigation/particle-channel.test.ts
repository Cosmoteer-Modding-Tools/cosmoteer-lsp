import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    particleChannelsOf,
    particleChannelAt,
    channelOccurrences,
    channelDefinitionSite,
    particleChannelCompletionsAtOffset,
} from '../../../src/features/navigation/particle-channel';

// A minimal particle effect: a writer in EmitterDef, readers/writers in Def, exercising the
// ParticleDataID channel detection across the whole file.
const SRC = `Type = Particles
Def
{
\tUpdaters
\t[
\t\t{
\t\t\tType = SetRandom
\t\t\tDataOut = rot_vel
\t\t\tValueType = Angle
\t\t}
\t\t{
\t\t\tType = Operator
\t\t\tAIn = rot
\t\t\tBIn = rot_vel
\t\t\tResultOut = rot
\t\t}
\t]
}
EmitterDef
{
\tPreInitializers
\t[
\t\t{
\t\t\tType = SetValue
\t\t\tDataOut = rot_vel
\t\t}
\t]
}
`;

const parse = () => parser(lexer(SRC), 'file:///mod/effect.rules').value;

describe('particle data channels', () => {
    it('detects channel occurrences by ParticleDataID field type with direction from the field suffix', () => {
        const channels = [...particleChannelsOf(parse())];
        const rotVel = channels.filter((c) => c.name === 'rot_vel');
        expect(rotVel.map((c) => c.direction).sort()).toEqual(['out', 'in', 'out'].sort());
        // `AIn`/`ResultOut` on `rot` give a read and a write.
        const rot = channels.filter((c) => c.name === 'rot');
        expect(rot.map((c) => c.direction).sort()).toEqual(['in', 'out'].sort());
        // ValueType=Angle is an enum, not a channel — must not be picked up.
        expect(channels.some((c) => c.name === 'Angle')).toBe(false);
    });

    it('finds all occurrences of a channel across Def and EmitterDef (file-wide scope)', () => {
        expect(channelOccurrences(parse(), 'rot_vel')).toHaveLength(3);
    });

    it('resolves the definition site to a writer (…Out)', () => {
        const site = channelDefinitionSite(parse(), 'rot_vel');
        expect(site?.direction === 'out' || site?.direction === 'inout').toBe(true);
    });

    it('locates the channel under the cursor', () => {
        const doc = parse();
        const lineWithBIn = SRC.split('\n').findIndex((l) => l.includes('BIn = rot_vel'));
        const character = SRC.split('\n')[lineWithBIn].indexOf('rot_vel') + 2;
        const channel = particleChannelAt(doc, { line: lineWithBIn, character });
        expect(channel?.name).toBe('rot_vel');
        expect(channel?.direction).toBe('in');
    });

    it('offers the file channel names at a ParticleDataID value position', () => {
        const doc = parse();
        // An offset inside the Operator group, at the `BIn = ` value position.
        const offset = SRC.indexOf('BIn = rot_vel') + 'BIn = '.length;
        const completions = particleChannelCompletionsAtOffset(doc, offset, '\t\t\tBIn = ');
        expect(completions).toBeDefined();
        expect(completions!.map((c) => (typeof c === 'string' ? c : c.label)).sort()).toEqual(['rot', 'rot_vel']);
    });

    it('returns undefined for a non-channel value position (so other completions run)', () => {
        const doc = parse();
        const offset = SRC.indexOf('ValueType = Angle') + 'ValueType = '.length;
        expect(particleChannelCompletionsAtOffset(doc, offset, '\t\t\tValueType = ')).toBeUndefined();
    });
});
