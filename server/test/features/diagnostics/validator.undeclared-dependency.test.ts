import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isValueNode } from '../../../src/core/ast/ast';
import {
    IdReference,
    undeclaredDependencyErrors,
} from '../../../src/features/diagnostics/validator.schema-id-reference';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { FIXTURES_DIR, walkAst } from '../../helpers';

const token = CancellationToken.None;
const DEPENDENCY_MOD = join(FIXTURES_DIR, 'dependency-mod');
const UNDECLARED_MOD = join(FIXTURES_DIR, 'undeclared-dep-mod');
const UNDECLARED_COPY = join(FIXTURES_DIR, 'undeclared-dep-mod-copy');
const DECLARED_MOD = join(FIXTURES_DIR, 'declared-dep-mod');
const RESOURCE_ID = 'test.dependency_resource';

/** The written value node naming the dependency's resource, the node a finding anchors on. */
const referenceIn = (document: AbstractNodeDocument): IdReference => {
    for (const node of walkAst(document) as Generator<AbstractNode>) {
        if (isValueNode(node) && String(node.valueType.value) === RESOURCE_ID) {
            return { node, targetClass: 'Cosmoteer.Resources.ResourceRules', value: RESOURCE_ID };
        }
    }
    throw new Error('reference not found');
};

const findingsFor = async (modDir: string, rescuingRoot: string) => {
    const document = await parseFilePath(join(modDir, 'uses.rules'));
    return undeclaredDependencyErrors(document, new Map([[rescuingRoot, referenceIn(document)]]), token);
};

// An id that only resolves because another mod happens to be installed here reads as correct on the
// author's machine and names nothing for anybody else. The rescue is silent today, which is the bug.
describe('undeclared dependency findings', () => {
    afterEach(() => {
        globalSettings.diagnostics.validateUndeclaredDependencies = true;
    });

    it('reports the mod that rescued the id, by name', async () => {
        const found = await findingsFor(UNDECLARED_MOD, DEPENDENCY_MOD);
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('Dependency Fixture');
        expect(found[0].severity).toBe('information');
    });

    it('does not present the manifest field as something the loader reads', async () => {
        // `ModInfo` reads ID, Name, Version and the compatible versions and nothing else, so the
        // dependency line is a note for this editor. A message that hangs the broken distribution
        // on the missing line reads as a loader rule and makes the quick fix look like the remedy.
        const [finding] = await findingsFor(UNDECLARED_MOD, DEPENDENCY_MOD);
        expect(finding.message).toContain('The game reads no dependency field');
        expect(finding.message).toContain('the player still has to install it');
        expect(finding.message).not.toContain('the manifest does not list it under Dependencies, so');
    });

    it('says it can never be a full dependency audit', async () => {
        const [finding] = await findingsFor(UNDECLARED_MOD, DEPENDENCY_MOD);
        expect(finding.additionalInfo).toContain('not a full list');
    });

    it('offers to write the dependency into the manifest', async () => {
        const [finding] = await findingsFor(UNDECLARED_MOD, DEPENDENCY_MOD);
        expect(finding.data?.addModDependency).toEqual({ token: 'Test.DependencyMod', name: 'Dependency Fixture' });
    });

    it('says nothing when the manifest already declares it', async () => {
        expect(await findingsFor(DECLARED_MOD, DEPENDENCY_MOD)).toEqual([]);
    });

    it('never reports a mod as depending on itself', async () => {
        // A mod edited in place inside the installed-mods tree vouches for its own ids.
        expect(await findingsFor(UNDECLARED_MOD, UNDECLARED_MOD)).toEqual([]);
    });

    it('never reports a mod as depending on its own second copy', async () => {
        // A mod worked on in the mods folder is usually installed from the workshop as well, and an
        // id it declares itself resolves into whichever copy the walk reached first. Two folders
        // writing one manifest id are one mod, so this is not a dependency on anything.
        expect(await findingsFor(UNDECLARED_MOD, UNDECLARED_COPY)).toEqual([]);
    });

    it('is silent when the setting is off', async () => {
        globalSettings.diagnostics.validateUndeclaredDependencies = false;
        expect(await findingsFor(UNDECLARED_MOD, DEPENDENCY_MOD)).toEqual([]);
    });

    it('says nothing when nothing was rescued', async () => {
        const document = await parseFilePath(join(UNDECLARED_MOD, 'uses.rules'));
        expect(await undeclaredDependencyErrors(document, new Map(), token)).toEqual([]);
    });
});

// The setting's own description is the other place the requirement is explained, and it is read by
// somebody deciding whether to switch the check on. It said the fix writes the dependency into the
// manifest, which leaves the entry looking like the thing that repairs the mod.
describe('the setting description of the undeclared-dependency check', () => {
    const description = (): string => {
        const packageJson = JSON.parse(readFileSync(join(FIXTURES_DIR, '..', '..', '..', 'package.json'), 'utf8')) as {
            contributes: { configuration: { properties: Record<string, { description?: string }> }[] };
        };
        for (const category of packageJson.contributes.configuration) {
            const own = category.properties['cosmoteerLSPRules.diagnostics.validateUndeclaredDependencies'];
            if (own?.description) return own.description;
        }
        throw new Error('setting not contributed');
    };

    it('says the game reads no dependency field', () => {
        expect(description()).toContain('The game reads no dependency field');
    });

    it('says the player still has to install the other mod', () => {
        expect(description()).toContain('the player still has to install it');
    });

    it('no longer presents the entry as the thing that repairs the mod', () => {
        expect(description()).not.toContain('writes the dependency into the manifest');
        expect(description()).not.toContain('breaks for everybody who does not have it');
    });
});
