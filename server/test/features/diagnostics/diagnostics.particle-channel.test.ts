import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateUnusedParticleChannels } from '../../../src/features/diagnostics/validator.particle-channel';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { initWorkspace } from '../../workspace-helper';

const token = CancellationToken.None;

const parse = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///particles.rules').value;

/** The channel name each finding names, in the order they are reported. */
const namesOf = (errors: { message: string }[]): string[] =>
    errors.map((error) => (error.message.match(/"([^"]+)"/) ?? ['', ''])[1]);

const channelsOf = async (source: string): Promise<string[]> =>
    namesOf(await validateUnusedParticleChannels(parse(source), token));

/** A reader that spells out every channel field its class has, so it adds a read of `channel` and
 *  leaves no defaulted field behind for the check to withhold judgement over. Its own `LocationInOut`
 *  both writes and reads, so it never becomes a finding of its own. */
const readerOf = (channel: string): string =>
    [
        '\t\t{',
        '\t\t\tType = FpsCompensator',
        '\t\t\tLocationInOut = location',
        `\t\t\tVelocityIn = ${channel}`,
        '\t\t}',
    ].join('\n');

/** An updater that writes `channel` and reads nothing, plus whatever the caller adds to it. */
const writerOf = (channel: string, extras = ''): string =>
    ['\t\t{', '\t\t\tType = SetRandom', `\t\t\tDataOut = ${channel}`, '\t\t\tValueType = Float', extras, '\t\t}']
        .filter((line) => line !== '')
        .join('\n');

/** An effect with one updater writing `rot_vel`, plus whatever the caller adds. */
const effect = (reader = '', writerExtras = ''): string =>
    ['Type = Particles', 'Def', '{', '\tUpdaters', '\t[', writerOf('rot_vel', writerExtras), reader, '\t]', '}', '']
        .filter((line) => line !== '')
        .join('\n');

/** The emitter half of an effect. `updater` is what its `PreInitializers` hold, `head` and `base`
 *  spell the seam that leads to the body the readers live in. */
const emitter = (updater = '', head = '', base = ''): string =>
    ['Type = Particles', head, `EmitterDef${base}`, '{', '\tPreInitializers', '\t[', updater, '\t]', '}']
        .filter((line) => line !== '')
        .join('\n');

/** The body half of an effect, the file an emitter names with `Def = &<…_def.rules>`. */
const bodyOf = (updater: string): string => ['Updaters', '[', updater, ']'].join('\n');

// A channel name is never checked by the game: a write whose reader is spelled differently is
// silently dead, and the particle simply draws without whatever that channel was computing.
describe('unused particle channels', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('reports a channel nothing reads', async () => {
        const errors = await validateUnusedParticleChannels(parse(effect()), token);
        expect(namesOf(errors)).toEqual(['rot_vel']);
        // Hint severity keeps this default-on check out of the Problems panel, and the unnecessary
        // tag is what fades the dropped write in the editor.
        expect(errors[0].severity).toBe('hint');
        expect(errors[0].unnecessary).toBe(true);
    });

    it('says nothing when an updater reads it', async () => {
        expect(await channelsOf(effect(readerOf('rot_vel')))).toEqual([]);
    });

    it('still reports when the reader spells the name in another case', async () => {
        // Channel names are interned exactly as written, so a differently cased name really is a
        // different channel and the write stays dead.
        expect(await channelsOf(effect(readerOf('ROT_VEL')))).toEqual(['rot_vel']);
    });

    it('does not report a write the author switched off', async () => {
        // `BaseParticleDataUpdater` runs its update only `if (Enabled)`, so nothing is computed and
        // there is no dropped value to report.
        expect(await channelsOf(effect('', '\t\t\tEnabled = false'))).toEqual([]);
    });

    it('counts an InOut field as both a read and a write', async () => {
        const source = [
            'Type = Particles',
            'Def',
            '{',
            '\tUpdaters',
            '\t[',
            '\t\t{',
            '\t\t\tType = AddFrameOfReference',
            '\t\t\tVelocityInOut = drift',
            '\t\t}',
            '\t]',
            '}',
            '',
        ].join('\n');
        expect(await channelsOf(source)).toEqual([]);
    });

    it('does not report a write under an Enabled the game reads as false', async () => {
        // The game's boolean reader takes more than the written word for false.
        expect(await channelsOf(effect('', String.raw`			Enabled = no`))).toEqual([]);
    });

    it('withholds judgement when an Enabled is a reference this editor cannot read', async () => {
        expect(await channelsOf(effect('', String.raw`			Enabled = &~/SWITCH`))).toEqual([]);
    });

    it('withholds judgement when a channel is named through a reference', async () => {
        // The occurrence walk reads a written name, so a reference names a reader it cannot see.
        expect(await channelsOf(effect(readerOf('&~/CHANNEL')))).toEqual([]);
    });

    it('says nothing about a file with no channel writes at all', async () => {
        expect(await channelsOf('Part\n{\n\tID = test.part\n}\n')).toEqual([]);
    });

    it('withholds judgement when a group leaves a defaulted channel field unwritten', async () => {
        // A non-nullable `ParticleDataID` field the file omits still binds the engine's own default
        // channel name, and that name is a reader this editor cannot see.
        const reader = ['\t\t{', '\t\t\tType = Lifetime', '\t\t}'].join('\n');
        expect(await channelsOf(effect(reader))).toEqual([]);
    });

    it('judges the file once that reader spells its own channels out', async () => {
        const reader = ['\t\t{', '\t\t\tType = Lifetime', '\t\t\tLifeInOut = life', '\t\t}'].join('\n');
        expect(await channelsOf(effect(reader))).toEqual(['rot_vel']);
    });

    it('reports a channel an emitter writes with no body named at all', async () => {
        // An emitter that names no body is the whole effect, so its own updaters are every reader
        // the channel will ever get.
        expect(await channelsOf(emitter(writerOf('rot_vel')))).toEqual(['rot_vel']);
    });

    it('says nothing when the body its Def names cannot be read', async () => {
        // The readers live in a file this editor cannot open, so judging the emitter alone would
        // report its whole channel set as dead.
        expect(await channelsOf(emitter(writerOf('rot_vel'), 'Def = &<no_such_file.rules>/Def'))).toEqual([]);
    });

    it('says nothing when an inherited base cannot be read', async () => {
        // An inherited base is the same seam as a `Def`: whatever it holds is part of this effect,
        // and a base that does not resolve hides readers just as a missing body does.
        expect(await channelsOf(emitter(writerOf('rot_vel'), '', ' : &<no_such_file.rules>/EmitterDef'))).toEqual([]);
    });
});

/** The files of one chained effect: a mod emitter inheriting a base whose `Def` names the body. */
const CHAIN_FILES: Record<string, string> = {
    'shared_def.rules': bodyOf(readerOf('channel_x')),
    'base_emitter.rules': emitter('', 'Def = &<shared_def.rules>'),
    'mod_emitter.rules': emitter(writerOf('channel_x'), '', ' : &<base_emitter.rules>/EmitterDef'),
    'mod_dead_emitter.rules': emitter(writerOf('channel_z'), '', ' : &<base_emitter.rules>/EmitterDef'),
};

/**
 * Writes `files` into a folder of their own and builds the reverse-include index over it, the way a
 * real project holds the two halves of an effect, then hands `check` a judge that names the dead
 * channels of any one of those files.
 *
 * @param files the file names and their text.
 * @param check runs the assertions over the folder.
 */
const inEffectFolder = async (
    files: Record<string, string>,
    check: (judge: (name: string) => Promise<string[]>) => Promise<void>
): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'particle-channel-'));
    try {
        for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
        ReverseIncludeIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([dir], token);
        await check(async (name) => {
            const path = join(dir, name);
            const document = parser(lexer(readFileSync(path, 'utf8')), pathToFileURL(path).href).value;
            return namesOf(await validateUnusedParticleChannels(document, token));
        });
    } finally {
        // The singleton stays the registered source in production too, so only its data is emptied.
        ReverseIncludeIndex.instance.reset();
        rmSync(dir, { recursive: true, force: true });
    }
};

// A particle effect is usually split in two: an emitter writes its channels in `PreInitializers` and
// pulls the body in with `Def = &<…_def.rules>`, and the readers live over there. Judging either half
// alone reports the other half's work as dead, so both are folded together first, in both directions.
describe('unused particle channels across the files of one effect', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('says nothing when the body its Def names holds the reader', async () => {
        await inEffectFolder(
            {
                'emitter.rules': emitter(writerOf('rot_vel'), 'Def = &<body_def.rules>'),
                'body_def.rules': bodyOf(readerOf('rot_vel')),
            },
            async (judge) => {
                expect(await judge('emitter.rules')).toEqual([]);
            }
        );
    });

    it('reports a write the body its Def names spells differently', async () => {
        await inEffectFolder(
            {
                'emitter.rules': emitter(writerOf('rot_vel'), 'Def = &<body_def.rules>'),
                'body_def.rules': bodyOf(readerOf('rotvel')),
            },
            async (judge) => {
                expect(await judge('emitter.rules')).toEqual(['rot_vel']);
            }
        );
    });

    it('says nothing about a body whose channel the emitter that includes it reads', async () => {
        // The other direction of the same fold: a body opened on its own writes for readers that
        // live in every emitter naming it, and that emitter is the file the index finds.
        await inEffectFolder(
            {
                'emitter.rules': emitter(readerOf('spin'), 'Def = &<body_def.rules>'),
                'body_def.rules': bodyOf(writerOf('spin')),
            },
            async (judge) => {
                expect(await judge('body_def.rules')).toEqual([]);
            }
        );
    });

    it('withholds judgement over a body when the emitter that includes it cannot be judged', async () => {
        // The emitter leaves `Lifetime`'s defaulted `LifeInOut` unwritten, so it binds a channel name
        // the schema does not record, and a reader of the body's write may be exactly that name.
        await inEffectFolder(
            {
                'emitter.rules': emitter(
                    ['\t\t{', '\t\t\tType = Lifetime', '\t\t}'].join('\n'),
                    'Def = &<body_def.rules>'
                ),
                'body_def.rules': bodyOf(writerOf('spin')),
            },
            async (judge) => {
                expect(await judge('body_def.rules')).toEqual([]);
            }
        );
    });

    it('reports a body that no file includes', async () => {
        await inEffectFolder({ 'lone_def.rules': bodyOf(writerOf('orphan')) }, async (judge) => {
            expect(await judge('lone_def.rules')).toEqual(['orphan']);
        });
    });

    it('follows an inherited base on to the body its own Def names', async () => {
        // A mod commonly inherits a base of its own whose `Def` names the shared body, so the readers
        // of what the mod writes sit two files away.
        await inEffectFolder(CHAIN_FILES, async (judge) => {
            expect(await judge('mod_emitter.rules')).toEqual([]);
        });
    });

    it('still reports a write no file in that chain reads', async () => {
        await inEffectFolder(CHAIN_FILES, async (judge) => {
            expect(await judge('mod_dead_emitter.rules')).toEqual(['channel_z']);
        });
    });
});
