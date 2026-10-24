import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { validateWeaponCoverage } from '../../../src/features/diagnostics/validator.weapon-coverage';
import { ValidationError } from '../../../src/features/diagnostics/validator';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

/**
 * Validates a part whose `Components` group holds the given components.
 *
 * @param components the component groups, written as text.
 * @returns the findings.
 */
const findings = async (...components: string[]): Promise<ValidationError[]> => {
    const uri = filePathToUri(workspaceFile('parts/coverage_probe/coverage_probe.rules'));
    const body = ['Part', '{', '\tID = coverage_probe.part', '\tComponents', '\t{', ...components, '\t}', '}', ''].join(
        '\n'
    );
    return validateWeaponCoverage(parseText(body, uri), token);
};

/**
 * A turret written with the given extra members.
 *
 * @param name the component id.
 * @param members the members, one per line.
 * @returns the component as text.
 */
const turret = (name: string, ...members: string[]): string =>
    [`\t\t${name}`, '\t\t{', '\t\t\tType = TurretWeapon', ...members.map((m) => `\t\t\t${m}`), '\t\t}'].join('\n');

/**
 * A fixed weapon written with the given extra members.
 *
 * @param name the component id.
 * @param members the members, one per line.
 * @returns the component as text.
 */
const fixed = (name: string, ...members: string[]): string =>
    [`\t\t${name}`, '\t\t{', '\t\t\tType = FixedWeapon', ...members.map((m) => `\t\t\t${m}`), '\t\t}'].join('\n');

/**
 * The messages of a run, for compact assertions.
 *
 * @param errors the findings.
 * @returns their messages.
 */
const messages = (errors: ValidationError[]): string[] => errors.map((error) => error.message);

describe('validateWeaponCoverage', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('flags a default arc that misses the physical arc entirely', async () => {
        const found = await findings(
            turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Arc = [170d, 20d] }')
        );
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain('does not overlap');
        expect(found[0].severity).toBe('warning');
    });

    it('reads the arc as wrapping round the circle', async () => {
        // From 170d a width of 40d reaches -150d, still clear of a 90d physical arc.
        expect(
            messages(await findings(turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Arc = [170d, 40d] }')))
        ).toHaveLength(1);
        // From 170d a width of 160d wraps round to -30d, inside it.
        expect(
            await findings(turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Arc = [170d, 160d] }'))
        ).toEqual([]);
    });

    it('leaves an arc that overlaps the physical arc alone, in either written form', async () => {
        expect(
            await findings(turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Arc = [30d, 60d] }'))
        ).toEqual([]);
        expect(
            await findings(
                turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Arc { NearEdge = -100d; Width = 70d } }')
            )
        ).toEqual([]);
    });

    it('reads the physical arc from ValidArc first, so a full circle never misses', async () => {
        expect(
            await findings(
                turret(
                    'Turret',
                    'FiringArc = 0d',
                    'ValidArc = 360d',
                    'DefaultWeaponCoverage { Range = 150; Arc = [-45d, 90d] }'
                )
            )
        ).toEqual([]);
    });

    it('flags a negative arc width', async () => {
        const found = await findings(
            turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Arc = [10d, -20d] }')
        );
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain('width is negative');
    });

    it('flags a range of zero or below and leaves a positive one alone', async () => {
        const zero = await findings(turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Range = 0 }'));
        expect(messages(zero)).toHaveLength(1);
        expect(zero[0].message).toContain('coverage range of 0');
        expect(
            messages(await findings(turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Range = -5 }')))
        ).toHaveLength(1);
        expect(await findings(turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { Range = 50 }'))).toEqual([]);
    });

    it('fades a range at or above the turret ValidRange', async () => {
        const found = await findings(
            turret('Turret', 'FiringArc = 90d', 'ValidRange = 100', 'DefaultWeaponCoverage { Range = 100 }')
        );
        expect(messages(found)).toHaveLength(1);
        expect(found[0].severity).toBe('hint');
        expect(found[0].unnecessary).toBe(true);
        expect(
            await findings(
                turret('Turret', 'FiringArc = 90d', 'ValidRange = 100', 'DefaultWeaponCoverage { Range = 99 }')
            )
        ).toEqual([]);
    });

    it('flags a turret RestPosition outside 0 to 1 unless the turret never returns to centre', async () => {
        const found = await findings(
            turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { RestPosition = 1.5 }')
        );
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain('RestPosition');
        expect(
            await findings(turret('Turret', 'FiringArc = 90d', 'DefaultWeaponCoverage { RestPosition = 0.25 }'))
        ).toEqual([]);
        expect(
            await findings(
                turret(
                    'Turret',
                    'FiringArc = 90d',
                    'ReturnToCenter = false',
                    'DefaultWeaponCoverage { RestPosition = 1.5 }'
                )
            )
        ).toEqual([]);
    });

    it('fades RestPosition on a fixed weapon, and an arc unless strict fire reads it', async () => {
        const found = await findings(fixed('Gun', 'DefaultWeaponCoverage { RestPosition = 0.5; Arc = [-10d, 20d] }'));
        expect(messages(found)).toHaveLength(2);
        expect(found.every((error) => error.severity === 'hint' && error.unnecessary)).toBe(true);
        expect(
            await findings(
                fixed('Gun', 'MatchWeaponCoverageStrictFire = true', 'DefaultWeaponCoverage { Arc = [-10d, 20d] }')
            )
        ).toEqual([]);
    });

    it('fades MatchWeaponCoverageStrictFire on a turret', async () => {
        const found = await findings(turret('Turret', 'FiringArc = 90d', 'MatchWeaponCoverageStrictFire = true'));
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain('Only a fixed weapon');
    });

    it('flags ForceCustomCoverageWidthZero beside a default arc of non-zero width', async () => {
        const found = await findings(
            turret(
                'Turret',
                'FiringArc = 90d',
                'ForceCustomCoverageWidthZero = true',
                'DefaultWeaponCoverage { Arc = [-10d, 20d] }'
            )
        );
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain('ForceCustomCoverageWidthZero');
        expect(
            await findings(
                turret(
                    'Turret',
                    'FiringArc = 90d',
                    'ForceCustomCoverageWidthZero = true',
                    'DefaultWeaponCoverage { Arc = [0d, 0d] }'
                )
            )
        ).toEqual([]);
    });

    it('flags a weapon matching its own coverage', async () => {
        const found = await findings(turret('Turret', 'FiringArc = 90d', 'MatchWeaponCoverage = Turret'));
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain('its own coverage');
    });

    it('flags a match naming a component that is not a weapon, and leaves a missing one to the reference check', async () => {
        const toggle = ['\t\tToggle', '\t\t{', '\t\t\tType = UIToggle', '\t\t\tToggleID = "probe"', '\t\t}'].join('\n');
        const found = await findings(turret('Turret', 'FiringArc = 90d', 'MatchWeaponCoverage = Toggle'), toggle);
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain("'Toggle' is not a weapon");
        expect(await findings(turret('Turret', 'FiringArc = 90d', 'MatchWeaponCoverage = Nowhere'))).toEqual([]);
    });

    it('flags a match naming a weapon that matches another one, and leaves a single hop alone', async () => {
        const found = await findings(
            turret('A', 'FiringArc = 90d', 'MatchWeaponCoverage = B'),
            turret('B', 'FiringArc = 90d', 'MatchWeaponCoverage = C'),
            turret('C', 'FiringArc = 90d')
        );
        expect(messages(found)).toHaveLength(1);
        expect(found[0].message).toContain("'B' matches another weapon");
        expect(
            await findings(
                fixed('Gun', 'MatchWeaponCoverage = Turret', 'MatchWeaponCoverageStrictFire = true'),
                turret('Turret', 'FiringArc = 90d')
            )
        ).toEqual([]);
    });

    it('reports a template once, however many weapons inherit it', async () => {
        const uri = filePathToUri(workspaceFile('parts/coverage_probe/coverage_probe.rules'));
        const body = [
            'Base',
            '{',
            '\tType = TurretWeapon',
            '\tFiringArc = 90d',
            '\tDefaultWeaponCoverage { Range = 0 }',
            '}',
            'Part',
            '{',
            '\tID = coverage_probe.part',
            '\tComponents',
            '\t{',
            '\t\tA : ~/Base { Location = [0, 0] }',
            '\t\tB : ~/Base { Location = [1, 0] }',
            '\t}',
            '}',
            '',
        ].join('\n');
        const found = await validateWeaponCoverage(parseText(body, uri), token);
        expect(messages(found)).toEqual([expect.stringContaining('coverage range of 0')]);
    });
});
