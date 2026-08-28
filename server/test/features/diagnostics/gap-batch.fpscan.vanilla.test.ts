import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { ValidationError } from '../../../src/features/diagnostics/validator';
import { validateIndicatorIndexes } from '../../../src/features/diagnostics/validator.indicator-index';
import { validateBlendSpriteCodes } from '../../../src/features/diagnostics/validator.blend-sprite';
import { validateRefusedEnumValues } from '../../../src/features/diagnostics/validator.refused-enum-value';
import { validateMishandledFields } from '../../../src/features/diagnostics/validator.mishandled-field';
import { validateChainedToCycles } from '../../../src/features/diagnostics/validator.chained-to-cycle';
import { validateValueRanges } from '../../../src/features/diagnostics/validator.value-range';
import { validateBulletComponents } from '../../../src/features/diagnostics/validator.bullet-components';
import { validateUnderlyingParts } from '../../../src/features/diagnostics/validator.underlying-part';
import { validateChainedBuffReceivable } from '../../../src/features/diagnostics/validator.unreceivable-buff';

// False-positive scan of the checks that judge a file against the game's own rules. Everything the
// game ships loads and runs, so every finding here is a false positive by definition, and all of
// these default to on. The text markup check is not among them: it judges only a mod's own language
// files and is silent on the game's by design. Needs the install, self-skips without.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

type Pass = (document: AbstractNodeDocument, token: CancellationToken) => Promise<ValidationError[]>;

/** Every pass, with the text that has to appear in a file before it is worth parsing for it. */
const PASSES: { name: string; run: Pass; trigger: RegExp }[] = [
    { name: 'indicator indexes', run: validateIndicatorIndexes, trigger: /HidesIndicators/i },
    { name: 'blend sprite codes', run: validateBlendSpriteCodes, trigger: /SituationCode/i },
    { name: 'refused enum values', run: validateRefusedEnumValues, trigger: /TargetType|FrameOfReference/i },
    { name: 'mishandled fields', run: validateMishandledFields, trigger: /ExcludeID|AllowUndefinedBlendSprites|Exponent/i },
    { name: 'component chains', run: validateChainedToCycles, trigger: /ChainedTo/i },
    { name: 'value ranges', run: validateValueRanges, trigger: /Pellets|ChainStrikes|Count|Quantity|TierRange|RandomHealthRange|ModeRange|MinParts|Amount|Left|Right|Top|Bottom/ },
    { name: 'bullet components', run: validateBulletComponents, trigger: /Components/i },
    { name: 'underlying parts', run: validateUnderlyingParts, trigger: /UnderlyingPart|CreatePart/i },
    { name: 'chained buffs', run: validateChainedBuffReceivable, trigger: /ChainsFromBuffType/i },
];

const rulesUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.toLowerCase().endsWith('.rules')) out.push(path);
        }
    };
    walk(root);
    return out;
};

describe.skipIf(!HAVE_DATA)('the 0.9.0 checks over vanilla Data', () => {
    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
    }, 300_000);

    it('finds nothing to say about the files the game ships', async () => {
        const findings: string[] = [];
        const judged = new Map<string, number>();
        for (const file of rulesUnder(DATA_DIR)) {
            let text: string;
            try {
                text = readFileSync(file, 'utf8');
            } catch {
                continue;
            }
            let document: AbstractNodeDocument | undefined;
            for (const pass of PASSES) {
                if (!pass.trigger.test(text)) continue;
                if (!document) {
                    try {
                        document = parser(lexer(text), pathToFileURL(file).href).value;
                    } catch {
                        break;
                    }
                }
                judged.set(pass.name, (judged.get(pass.name) ?? 0) + 1);
                for (const error of await pass.run(document, token)) {
                    findings.push(`[${pass.name}] ${relative(DATA_DIR, file)}: ${error.message}`);
                }
            }
        }
        // Anti-vacuity: a pass that reached no file at all proves nothing by finding nothing.
        for (const pass of PASSES) expect(judged.get(pass.name) ?? 0, `${pass.name} reached no file`).toBeGreaterThan(0);
        expect(findings).toEqual([]);
    }, 600_000);
});
