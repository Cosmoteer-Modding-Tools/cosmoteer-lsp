import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseText } from '../../../../src/utils/ast.utils';
import { buildBaseFileText, relativeRulesReference } from '../../../../src/features/refactor/shared-base/base-file.emitter';
import { buildConsumerEdits } from '../../../../src/features/refactor/shared-base/consumer-rewrite';
import {
    AnalysisFile,
    buildExtractionPlans,
} from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';

// Mods written on Windows ship `\r\n`. The fixtures on disk cannot carry it (.gitattributes forces
// `*.rules` to LF so the parser's byte-offset snapshots stay stable), so the text is built here.
// Nothing in this file touches the disk: a clone family with no references never needs to.
const MOD_DIR = 'C:/mods/crlf-mod';
const NAMES = ['engine_a.rules', 'engine_b.rules', 'engine_c.rules'];

const source = (name: string): string =>
    [
        'Part',
        '{',
        `\tNameKey = "Parts/${name}"`,
        '\tDensity = 3',
        '\tIsRotateable = false',
        '\tCrewSpeedFactor = 0',
        '}',
        '',
    ].join('\r\n');

const load = (): AnalysisFile[] =>
    NAMES.map((name) => {
        const fsPath = `${MOD_DIR}/parts/${name}`;
        const text = source(name);
        return { document: parseText(text, fsPath), text, fsPath, uri: `file:///${fsPath}` };
    });

describe('shared base extraction on a file written with CRLF', () => {
    it('finds the same fields it would in an LF file', () => {
        const plans = buildExtractionPlans(load(), { anchorDir: MOD_DIR });
        expect(plans).toHaveLength(1);
        expect(plans[0].fields).toEqual(['density', 'isrotateable', 'crewspeedfactor']);
    });

    it('writes the base file with the ending the mod already uses', () => {
        const plan = buildExtractionPlans(load(), { anchorDir: MOD_DIR })[0];
        const text = buildBaseFileText(plan, '\r\n');
        expect(text).toBe(
            ['Part', '{', '\tDensity = 3', '\tIsRotateable = false', '\tCrewSpeedFactor = 0', '}', ''].join('\r\n')
        );
        // No stray lone newline: every break is the one that was asked for.
        expect(/[^\r]\n/.test(text)).toBe(false);
    });

    it('rewrites a CRLF consumer without leaving a broken line behind', () => {
        const plan = buildExtractionPlans(load(), { anchorDir: MOD_DIR })[0];
        const participant = plan.participants[0];
        const doc = TextDocument.create(participant.uri, 'rules', 0, source(NAMES[0]));
        const reference = relativeRulesReference(`${MOD_DIR}/parts`, plan.baseFsPath, plan.groupName);
        const rewritten = TextDocument.applyEdits(doc, buildConsumerEdits(doc, participant, plan, reference));
        expect(rewritten).toBe(
            ['Part : <base_engine.rules>/Part', '{', '\tNameKey = "Parts/engine_a.rules"', '}', ''].join('\r\n')
        );
    });
});
