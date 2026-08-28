import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateBulletComponents } from '../../../src/features/diagnostics/validator.bullet-components';
import { workspaceFile } from '../../workspace-helper';

const SHOT_PATH = workspaceFile('shots', 'test_shot.rules');
const token = CancellationToken.None;

const findings = async (text: string): Promise<string[]> =>
    (await validateBulletComponents(parser(lexer(text), SHOT_PATH).value, token)).map((error) => error.message);

/**
 * A bullet carrying the given components, in the order they are written.
 *
 * @param components the component declarations, each a name and the inside of its `{ }`.
 * @returns the bullet file text.
 */
const bulletWith = (...components: [string, string][]): string =>
    [
        'Bullet',
        '{',
        '\tComponents',
        '\t{',
        ...components.flatMap(([name, body]) => [`\t\t${name}`, '\t\t{', `\t\t\t${body}`, '\t\t}']),
        '\t}',
        '}',
        '',
    ].join('\n');

const PHYSICS: [string, string] = ['Physics', 'Type = CirclePhysics\n\t\t\tRadius = 0.1'];
const HIT: [string, string] = ['Hit', 'Type = SimpleHit'];

// The bullet is built by walking its components in order and handing each one the bullet, so three
// things about that walk are decided by the written order and by nothing else.
describe('bullet component sets the game cannot build', () => {
    it('says nothing about a bullet whose physics comes first', async () => {
        expect(await findings(bulletWith(PHYSICS, HIT))).toEqual([]);
    });

    it('flags a second physics component', async () => {
        expect(await findings(bulletWith(PHYSICS, ['Physics2', 'Type = BoxPhysics']))).toEqual([
            "'Physics2' is a second physics component, and a bullet takes one. The game throws as it is set.",
        ]);
    });

    it('flags a bullet with no physics component at all', async () => {
        expect(await findings(bulletWith(HIT))).toEqual([
            'This bullet has no physics component. The game throws once it has built the rest of them.',
        ]);
    });

    it('flags a hit written above the physics component', async () => {
        expect(await findings(bulletWith(HIT, PHYSICS))).toEqual([
            "'Hit' reads the bullet's physics while it is being built, and 'Physics' is written below it, so the game throws on the first shot. Move the physics component above it.",
        ]);
    });

    it('flags a targetable written above the physics component', async () => {
        expect(await findings(bulletWith(['Target', 'Type = Targetable'], PHYSICS))).toEqual([
            "'Target' reads the bullet's physics while it is being built, and 'Physics' is written below it, so the game throws on the first shot. Move the physics component above it.",
        ]);
    });

    it('leaves media effects above the physics alone, which return before touching it when empty', async () => {
        expect(await findings(bulletWith(['Effects', 'Type = MediaEffects'], PHYSICS))).toEqual([]);
    });

    it('leaves a sprite above the physics alone, which reads it nowhere', async () => {
        expect(await findings(bulletWith(['Art', 'Type = Sprite'], PHYSICS))).toEqual([]);
    });

    it('says nothing about a group of components that is not a bullet set', async () => {
        const part = ['Part', '{', '\tComponents', '\t{', '\t\tX', '\t\t{', '\t\t\tType = Sprite', '\t\t}', '\t}', '}', ''].join('\n');
        expect(await findings(part)).toEqual([]);
    });
});
