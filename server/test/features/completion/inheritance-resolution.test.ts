import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, GroupNode, isAssignmentNode } from '../../../src/core/ast/ast';
import { findNodeByIdentifier, parseFilePath } from '../../../src/utils/ast.utils';
import { resolveClassThroughInheritance } from '../../../src/features/completion/inheritance-resolution';
import { HoverService } from '../../../src/features/hover/hover.service';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// Cross-file inheritance classification: a deriving group with no `Type=` of its own takes its
// schema class from the base its `: ref` points at. The whole-file case (`: /BASE_SHAKE`, where
// the macro aliases a rootless fragment whose top level is the group body) used to be skipped
// (the resolver hands back a File/Document, not a group), leaving the deriver classless and its
// field completion dark. Mirrors the game's `: /BASE_SHAKE` screen-shake idiom.
const token = CancellationToken.None;

describe('resolveClassThroughInheritance: cross-file bases', () => {
    let consumer: AbstractNodeDocument;
    let myShake: GroupNode;
    let mySound: GroupNode;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        consumer = await parseFilePath(workspaceFile('effects', 'inherits_shake.rules'));
        myShake = findNodeByIdentifier(consumer, 'MyShake') as GroupNode;
        mySound = findNodeByIdentifier(consumer, 'MySound') as GroupNode;
        expect(myShake).toBeDefined();
        expect(mySound).toBeDefined();
    });

    it('classifies a whole-file base from the fragment file’s top-level `Type=` (`: /BASE_SHAKE`)', async () => {
        const cls = await resolveClassThroughInheritance(myShake, token);
        expect(cls).toBe('Cosmoteer.Simulation.MediaEffects.ScreenShakeEffectRules');
    });

    it('classifies a cross-file GROUP base from the base group’s `Type=` (`: /BASE_AUDIO/BaseAudio`)', async () => {
        const cls = await resolveClassThroughInheritance(mySound, token);
        expect(cls).toBe('Cosmoteer.Simulation.MediaEffects.AudioEffectRules');
    });

    it('hover shows the schema field signature inside a whole-file-inherited group', async () => {
        // Hover on `ShakeAmount` in `MyShake : /BASE_SHAKE { … }`: the field belongs to the class
        // the whole-file base carries, which only the async inheritance resolution can reach.
        const assignment = myShake.elements.find(
            (e) => isAssignmentNode(e) && e.left.name === 'ShakeAmount'
        ) as { left: { position: { line: number; characterStart: number } } } | undefined;
        expect(assignment).toBeDefined();
        const hover = await HoverService.instance.getHover(
            consumer,
            { line: assignment!.left.position.line, character: assignment!.left.position.characterStart + 1 },
            token
        );
        const text = hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
        expect(text).toContain('ShakeAmount');
        expect(text).toContain('ModifiableValue');
    });
});
