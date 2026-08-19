import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isValueNode } from '../../../src/core/ast/ast';
import { IdReference, undeclaredDependencyErrors } from '../../../src/features/diagnostics/validator.schema-id-reference';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { FIXTURES_DIR, walkAst } from '../../helpers';

const token = CancellationToken.None;
const DEPENDENCY_MOD = join(FIXTURES_DIR, 'dependency-mod');
const UNDECLARED_MOD = join(FIXTURES_DIR, 'undeclared-dep-mod');
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

    it('is silent when the setting is off', async () => {
        globalSettings.diagnostics.validateUndeclaredDependencies = false;
        expect(await findingsFor(UNDECLARED_MOD, DEPENDENCY_MOD)).toEqual([]);
    });

    it('says nothing when nothing was rescued', async () => {
        const document = await parseFilePath(join(UNDECLARED_MOD, 'uses.rules'));
        expect(await undeclaredDependencyErrors(document, new Map(), token)).toEqual([]);
    });
});
