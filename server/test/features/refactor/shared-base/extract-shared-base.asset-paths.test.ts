import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseText } from '../../../../src/utils/ast.utils';
import { buildBaseFileText } from '../../../../src/features/refactor/shared-base/base-file.emitter';
import {
    AnalysisFile,
    buildExtractionPlans,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';
import { FIXTURES_DIR } from '../../../helpers';

// A relative asset path is resolved against the directory of the file it is written in, so moving a
// field that carries one into a base file in another directory re-points it. This is the shape a
// per-part folder layout produces, and every part writing `File = "icon.png"` next to its own icon
// spells the field identically while meaning three different images. The fixture holds only the
// assets: the rules text is built here, because what matters is which paths exist on disk.
const MOD_DIR = join(FIXTURES_DIR, 'shared-base-assets').replace(/\\/g, '/');
const FOLDERS = ['a', 'b', 'c'];

const load = (iconPath: string): AnalysisFile[] =>
    FOLDERS.map((folder) => {
        const fsPath = `${MOD_DIR}/${folder}/part_${folder}.rules`;
        const text = [
            'Part',
            '{',
            `\tID = test.part_${folder}`,
            '\tDensity = 3',
            '\tIsRotateable = false',
            '\tJobsIcon',
            '\t{',
            '\t\tTexture',
            '\t\t{',
            `\t\t\tFile = "${iconPath}"`,
            '\t\t}',
            '\t}',
            '}',
            '',
        ].join('\n');
        return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
    });

describe('a member carrying a relative asset path', () => {
    it('is not extracted when each file means a different image by the same spelling', () => {
        // a/icon.png, b/icon.png and c/icon.png are three different files. Expressing each path
        // relative to the mod root is what makes the three members stop comparing equal, so no plan
        // can move them into one base file and leave all three pointing at a/icon.png.
        const plans = buildExtractionPlans(load('icon.png'), { anchorDir: MOD_DIR });
        expect(plans).toHaveLength(1);
        expect(plans[0].fields).toEqual(['density', 'isrotateable']);
        expect(plans[0].fields).not.toContain('jobsicon');
    });

    it('is extracted and re-expressed when every file really does mean the same image', () => {
        const plans = buildExtractionPlans(load('../common/shared.png'), { anchorDir: MOD_DIR });
        expect(plans).toHaveLength(1);
        expect(plans[0].fields).toContain('jobsicon');
        // The base file lands in the directory the three parts share, one level above them, so the
        // path it writes has to lose the `../` the parts needed.
        expect(plans[0].baseFsPath).toBe(`${MOD_DIR}/base_part.rules`);
        expect(buildBaseFileText(plans[0])).toContain('File = "common/shared.png"');
        expect(buildBaseFileText(plans[0])).not.toContain('../common/shared.png');
    });

    it('is not extracted when the path names nothing on disk, since it cannot be proven', () => {
        const plans = buildExtractionPlans(load('missing/nowhere.png'), { anchorDir: MOD_DIR });
        expect(plans).toHaveLength(1);
        expect(plans[0].fields).not.toContain('jobsicon');
    });
});

describe('a member carrying a quoted expression', () => {
    const withExpression = (): AnalysisFile[] =>
        FOLDERS.map((folder, index) => {
            const fsPath = `${MOD_DIR}/${folder}/part_${folder}.rules`;
            const text = [
                `BASE_DAMAGE = ${(index + 1) * 100}`,
                'Part',
                '{',
                `\tID = test.part_${folder}`,
                '\tDensity = 3',
                '\tIsRotateable = false',
                '\tMaxHealth = "round((&~/BASE_DAMAGE) * 40, 0)"',
                '}',
                '',
            ].join('\n');
            return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
        });

    it('is never moved, because the reference inside the quotes resolves against its own file', () => {
        // The three files spell MaxHealth identically but mean 4000, 8000 and 12000, because `~`
        // starts at the root of the file the value is written in. Judging quoted text like any other
        // is what keeps them apart and keeps the reference from being re-pointed at the base file.
        const plans = buildExtractionPlans(withExpression(), { anchorDir: MOD_DIR });
        expect(plans).toHaveLength(1);
        expect(plans[0].fields).toEqual(['density', 'isrotateable']);
        expect(plans[0].fields).not.toContain('maxhealth');
    });
});
