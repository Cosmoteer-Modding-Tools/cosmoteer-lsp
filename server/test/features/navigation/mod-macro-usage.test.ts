import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { GroupNode, ListNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import { memberTypeIn, resolveGroupClass } from '../../../src/document/schema/schema-context';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { cachedParseFilePath } from '../../../src/workspace/fs-cache';

// A mod's convenience container (`Add` of a named member to `cosmoteer.rules`, then `&/NAME/Member`
// usages) types its members from the slots that read them, the mod-side counterpart of the vanilla
// COMMON_EFFECTS/PRIORITIES macro-usage typing. The harvest and the usage live in different files
// with arbitrary scan order, so this also exercises the fixpoint retention of unresolved ALL_CAPS
// usages.
const token = CancellationToken.None;

describe('mod macro container usage typing', () => {
    it('types a container member from the slot that reads it through the mod macro', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'modmacro-'));
        try {
            writeFileSync(
                join(dir, 'mod.rules'),
                'ID = test.mod\nActions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = <cosmoteer.rules>\n\t\tName = MY_FX\n\t\tToAdd = &<fx.rules>\n\t}\n]\n'
            );
            const fxText = 'Boom\n[\n\t{\n\t\tType = ScreenShake\n\t\tShakeAmount = 1\n\t}\n]\n';
            writeFileSync(join(dir, 'fx.rules'), fxText);
            writeFileSync(
                join(dir, 'part.rules'),
                'Part\n{\n\tComponents\n\t{\n\t\tDestroyedEffects\n\t\t{\n\t\t\tType = DeathEffects\n\t\t\tMediaEffects = &/MY_FX/Boom\n\t\t}\n\t}\n}\n'
            );

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const fxDoc = parser(lexer(fxText), pathToFileURL(join(dir, 'fx.rules')).href).value;
            const type = memberTypeIn(fxDoc, 'Boom');
            expect(type?.kind).toBe('group');
            expect(type && 'ref' in type && type.ref).toBe('Cosmoteer.Simulation.MediaEffects.MultiMediaEffectRules');
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('types a deep container leaf from the slot that reads it, leaving the folder groups untyped', async () => {
        // `&/MY_FX/Cat/Sub/Boom` reads a leaf nested under folder-like groups. The slot describes
        // the leaf, so the leaf list types (and through the MultiMediaEffects value form its
        // elements resolve their media-effect classes), while the folder groups Cat/Sub stay
        // untyped, since no class exists for them.
        const dir = mkdtempSync(join(tmpdir(), 'modmacro-deep-'));
        try {
            writeFileSync(
                join(dir, 'mod.rules'),
                'ID = test.mod\nActions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = <cosmoteer.rules>\n\t\tName = MY_FX\n\t\tToAdd = &<fx.rules>\n\t}\n]\n'
            );
            const fxText = 'Cat\n{\n\tSub\n\t{\n\t\tBoom\n\t\t[\n\t\t\t{\n\t\t\t\tType = ScreenShake\n\t\t\t\tShakeAmount = 1\n\t\t\t}\n\t\t]\n\t}\n}\n';
            writeFileSync(join(dir, 'fx.rules'), fxText);
            writeFileSync(
                join(dir, 'part.rules'),
                'Part\n{\n\tComponents\n\t{\n\t\tDestroyedEffects\n\t\t{\n\t\t\tType = DeathEffects\n\t\t\tMediaEffects = &/MY_FX/Cat/Sub/Boom\n\t\t}\n\t}\n}\n'
            );

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            // The leaf record is position-keyed, so resolve against the same parse the scan used.
            const fxDoc = (await cachedParseFilePath(join(dir, 'fx.rules')))!;
            const cat = fxDoc.elements.find((e): e is GroupNode => isGroupNode(e) && e.identifier?.name === 'Cat')!;
            const sub = cat.elements.find((e): e is GroupNode => isGroupNode(e) && e.identifier?.name === 'Sub')!;
            const boom = sub.elements.find((e): e is ListNode => isListNode(e) && e.identifier?.name === 'Boom')!;
            const shake = boom.elements.find(isGroupNode)!;
            expect(resolveGroupClass(shake)).toBe('Cosmoteer.Simulation.MediaEffects.ScreenShakeEffectRules');
            expect(resolveGroupClass(cat)).toBeUndefined();
            expect(resolveGroupClass(sub)).toBeUndefined();
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('roots the referenced file when the deep leaf is a member-less alias', async () => {
        // `&/MY_FX/Cat/Boom` lands on `Boom = &<boom.rules>`, the dominant leaf shape in the SW
        // containers: the slot dereferences the one file hop and types boom.rules itself.
        const dir = mkdtempSync(join(tmpdir(), 'modmacro-ref-'));
        try {
            writeFileSync(
                join(dir, 'mod.rules'),
                'ID = test.mod\nActions\n[\n\t{\n\t\tAction = Add\n\t\tAddTo = <cosmoteer.rules>\n\t\tName = MY_FX\n\t\tToAdd = &<fx.rules>\n\t}\n]\n'
            );
            writeFileSync(join(dir, 'fx.rules'), 'Cat\n{\n\tBoom = &<boom.rules>\n}\n');
            const boomText = 'Effects\n[\n\t{\n\t\tType = ScreenShake\n\t\tShakeAmount = 1\n\t}\n]\n';
            writeFileSync(join(dir, 'boom.rules'), boomText);
            writeFileSync(
                join(dir, 'part.rules'),
                'Part\n{\n\tComponents\n\t{\n\t\tDestroyedEffects\n\t\t{\n\t\t\tType = DeathEffects\n\t\t\tMediaEffects = &/MY_FX/Cat/Boom\n\t\t}\n\t}\n}\n'
            );

            ReverseIncludeIndex.instance.reset();
            await ReverseIncludeIndex.instance.ensureBuilt([dir], token);

            const boomDoc = parser(lexer(boomText), pathToFileURL(join(dir, 'boom.rules')).href).value;
            const effects = memberTypeIn(boomDoc, 'Effects');
            expect(effects?.kind).toBe('list');
        } finally {
            ReverseIncludeIndex.instance.reset();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
