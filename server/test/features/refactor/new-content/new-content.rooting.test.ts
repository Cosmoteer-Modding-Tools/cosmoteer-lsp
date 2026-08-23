import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { isGroupNode } from '../../../../src/core/ast/ast';
import { classFitsDocument, documentRootClass } from '../../../../src/document/schema/document-root';
import { resolveGroupClass } from '../../../../src/document/schema/schema-context';
import {
    contentFilePathOf,
    emitContent,
} from '../../../../src/features/refactor/new-content/content-templates';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// Whether the editor types a created file at all, which is a stricter question than whether the game
// loads it. Three of the four kinds are whole-file roots that only root because of where they were
// put, and the fourth is not a whole-file root at all, which is exactly why creating and registering
// have to be one exchange.
const MOD_DIR = join(FIXTURES_DIR, 'new-content-mod', 'mod').replace(/\\/g, '/');

/** The template for a kind, parsed at the path the command would create it at. */
const emitted = (kind: 'part' | 'resource' | 'bullet' | 'mediaEffect', id: string) => {
    const fsPath = contentFilePathOf(MOD_DIR, kind, 'test_thing');
    return parseText(emitContent(kind, 'test_thing', id).text, fsPath);
};

describe('what the editor makes of a created file', () => {
    it('types a created resource as a resource, and it owns every field it writes', () => {
        const document = emitted('resource', 'test_thing');
        expect(documentRootClass(document)).toBe('Cosmoteer.Resources.ResourceRules');
        expect(classFitsDocument('Cosmoteer.Resources.ResourceRules', document)).toBe(true);
    });

    it('types a created shot as a bullet, and it owns every field it writes', () => {
        const document = emitted('bullet', 'test.test_thing');
        expect(documentRootClass(document)).toBe('Cosmoteer.Bullets.BulletRules');
        expect(classFitsDocument('Cosmoteer.Bullets.BulletRules', document)).toBe(true);
    });

    it('types a created media effect through its own Type, wherever the file happens to sit', () => {
        const text = emitContent('mediaEffect', 'test_thing', '').text;
        for (const fsPath of [`${MOD_DIR}/effects/test_thing.rules`, `${MOD_DIR}/somewhere/else/test_thing.rules`]) {
            const document = parseText(text, fsPath);
            expect(documentRootClass(document)).toBe('Cosmoteer.Simulation.MediaEffects.AudioEffectRules');
            expect(classFitsDocument('Cosmoteer.Simulation.MediaEffects.AudioEffectRules', document)).toBe(true);
        }
    });

    it('roots a resource and a shot by their folder, so the folder is part of the template', () => {
        // Moved out of `resources/` and `shots/` the very same text types as nothing at all. This is
        // the reason the command chooses the folder rather than asking for one.
        const resource = parseText(emitContent('resource', 'test_thing', 'test_thing').text, `${MOD_DIR}/stuff/x.rules`);
        expect(documentRootClass(resource)).toBeUndefined();
        const bullet = parseText(emitContent('bullet', 'test_thing', 'test.x').text, `${MOD_DIR}/stuff/x.rules`);
        expect(documentRootClass(bullet)).toBeUndefined();
    });

    it('leaves a created part untyped as a file, and typed as a part group', () => {
        // A part file is not a whole-file root: nothing in the path rules names one, so a part is
        // typed only through whatever registers it. Its own `Part { … }` group still anchors by name,
        // which is what lets the field checks judge the template at all.
        const document = emitted('part', 'test.test_thing');
        expect(documentRootClass(document)).toBeUndefined();
        const group = document.elements.find(isGroupNode)!;
        expect(resolveGroupClass(group)).toBe('Cosmoteer.Ships.Parts.PartRules');
    });
});
