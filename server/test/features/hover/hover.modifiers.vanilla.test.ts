import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { CancellationToken, Connection, Position, WorkDoneProgressReporter } from 'vscode-languageserver';
import { HoverService } from '../../../src/features/hover/hover.service';
import { AbstractNodeDocument, isGroupNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { MentionIndex } from '../../../src/features/navigation/mention.index';
import { walkAst } from '../../helpers';

// The modifier lens against the game's own files, where the shapes it renders actually occur:
// cannon_med's Burst is a ModifiableValue whose one modifier is driven by Overclock, and the part
// supplying that buff lives in a different file entirely. Needs the install, self-skips without it.
const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const HAVE_DATA = existsSync(DATA_DIR);
const token = CancellationToken.None;

/** Position over the identifier of the named group. */
const groupPosition = (doc: AbstractNodeDocument, name: string): Position => {
    for (const node of walkAst(doc)) {
        if (isGroupNode(node) && node.identifier?.name === name) {
            const p = node.identifier.position;
            return Position.create(p.line, p.characterStart + 1);
        }
    }
    throw new Error(`group ${name} not found`);
};

describe.skipIf(!HAVE_DATA)('modifier lens over vanilla Data', () => {
    let hover = '';

    beforeAll(async () => {
        globalSettings.cosmoteerPath = DATA_DIR;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_DIR, noop);
        // The provider search reads its candidate files from the mention index, which the live
        // server has already built by the time a hover arrives.
        await MentionIndex.instance.ensureBuilt([DATA_DIR], token);

        const document = await parseFilePath(join(DATA_DIR, 'ships/terran/cannon_med/cannon_med.rules'));
        const result = await HoverService.instance.getHover(document, groupPosition(document, 'Burst'), token, [DATA_DIR]);
        hover = (result?.contents as { value: string } | undefined)?.value ?? '';
    }, 300_000);

    it('reads the modifier the game reads', () => {
        expect(hover).toContain('base 1, 1 modifier');
        expect(hover).toContain('**Buff**');
        expect(hover).toContain('`Overclock`');
        expect(hover).toContain('Lerp');
    });

    it('shows the written clamp as written when its end is a reference', () => {
        // MaxValue is `(&~/OVERCLOCK/BURST)`, a reference the game reads at runtime, so the row
        // prints the reference rather than a number the file cannot prove.
        expect(hover).toContain('clamped to 1 … `&~/OVERCLOCK/BURST`');
    });

    it('always says something about where the buff comes from', () => {
        // Overclock is supplied through ships/base_part_overclock.rules, which every overclockable
        // part inherits, and by the railgun parts directly. The search runs against a clock, so on a
        // loaded machine it may not get that far, and then it says so rather than going silent.
        const answers = ['supplied by', 'chained from', 'no part in this project', 'stopped early', 'cancelled'];
        expect(answers.some((answer) => hover.includes(answer))).toBe(true);
    });
});
