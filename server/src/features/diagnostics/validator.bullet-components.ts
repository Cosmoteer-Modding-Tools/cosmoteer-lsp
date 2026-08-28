import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
} from '../../core/ast/ast';
import { childNodesOf, getStartOfAstNode } from '../../utils/ast.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { typeDef } from '../../document/schema/schema';
import { flattenGroup } from '../../semantics/effective-group';
import { ValidationError } from './validator';

/** The registry every child of a bullet's `Components` group belongs to. */
const BULLET_COMPONENT_REGISTRY = 'Cosmoteer.Bullets.BulletComponentRules';

/** The member of a bullet holding its components. */
const COMPONENTS = 'components';

/** The two classes that give a bullet the physics body every other component hangs off. */
const PHYSICS_CLASSES: ReadonlySet<string> = new Set([
    'Cosmoteer.Bullets.Physics.BulletCirclePhysicsRules',
    'Cosmoteer.Bullets.Physics.BulletBoxPhysicsRules',
]);

/**
 * The classes whose constructor reads the bullet's physics component while the components are still
 * being built, so one written above the physics component finds nothing there.
 *
 * `MediaEffects` reads it too and is deliberately not here: its `AddComponents` returns before
 * touching the bullet when its effect list is empty, so the order only matters for some of them and
 * the check would be claiming more than it knows.
 */
const NEEDS_PHYSICS_CLASSES: ReadonlySet<string> = new Set([
    'Cosmoteer.Bullets.Hits.BulletSimpleHitRules',
    'Cosmoteer.Bullets.Hits.BulletPenetratingHitRules',
    'Cosmoteer.Bullets.Hits.BulletVolumeHitRules',
    'Cosmoteer.Bullets.Targeting.BulletTargetableRules',
]);

/** One component of the merged group, in the order the game builds them. */
interface BulletComponent {
    readonly name: string;
    readonly cls: string;
    /** The declaration, which the finding is anchored on where this document holds it. */
    readonly node: AbstractNode;
}

/** Whether a class is a member of the bullet component registry. */
const isBulletComponent = (cls: string): boolean => typeDef(cls)?.registry === BULLET_COMPONENT_REGISTRY;

/**
 * Every group in the document that is a bullet's own component set, which is a `Components` group
 * holding at least one child the schema types as a bullet component. Gating on the container rather
 * than on the file leaves alone the many files that root as a bullet while carrying no components at
 * all.
 *
 * @param node the node to walk.
 * @returns a generator of the bullet component groups found under it.
 */
function* bulletComponentGroupsIn(node: AbstractNode): Generator<GroupNode> {
    const named = isAssignmentNode(node)
        ? node.left.name.toLowerCase() === COMPONENTS && isGroupNode(node.right)
            ? node.right
            : undefined
        : isGroupNode(node) && node.identifier?.name.toLowerCase() === COMPONENTS
          ? node
          : undefined;
    if (named) {
        for (const child of named.elements) {
            if (!isGroupNode(child)) continue;
            const cls = resolveGroupClass(child);
            if (cls && isBulletComponent(cls)) {
                yield named;
                break;
            }
        }
    }
    for (const child of childNodesOf(node)) yield* bulletComponentGroupsIn(child);
}

/**
 * Flags the three shapes of a bullet's component set the game cannot build.
 *
 * A bullet is built by walking its components in order and handing each one the bullet, and three
 * things about that walk are decided by the written order rather than by any value. A second physics
 * component throws as it is set. No physics component at all throws once the walk ends. And a hit or
 * a targetable written above the physics component reads the physics that is not there yet, which is
 * the sharp one: group member order means nothing anywhere else in the format, so nothing about the
 * file suggests that moving a block matters.
 *
 * The order is the merged one, since a base's members come first and a derived file re-declaring the
 * physics component moves it behind everything the file writes above it.
 *
 * Silent about anything it cannot read in full: a base it could not follow, a child whose class does
 * not resolve, and a child written as anything but a group, which is how a file deletes an inherited
 * component rather than declaring one.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk and the fold.
 * @returns one finding per component set the game would refuse to build.
 */
export const validateBulletComponents = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const containers: GroupNode[] = [];
    for (const element of document.elements) containers.push(...bulletComponentGroupsIn(element));

    for (const container of containers) {
        if (cancellationToken.isCancellationRequested) return errors;
        const flattened = await flattenGroup(container, cancellationToken).catch(() => null);
        if (!flattened || !flattened.complete) continue;

        const components: BulletComponent[] = [];
        let unreadable = false;
        for (const member of flattened.members) {
            const value = member.value;
            // A member written with no value at all deletes the inherited component of that name,
            // which changes the set in a way this walk cannot stand behind.
            if (!value || !isGroupNode(value)) {
                unreadable = true;
                break;
            }
            const cls = resolveGroupClass(value);
            if (!cls) {
                unreadable = true;
                break;
            }
            components.push({ name: member.name, cls, node: value });
        }
        if (unreadable || components.length === 0) continue;

        const local = (component: BulletComponent): boolean =>
            getStartOfAstNode(component.node).uri === document.uri;
        const physics = components.filter((component) => PHYSICS_CLASSES.has(component.cls));

        if (physics.length > 1) {
            const second = physics[1];
            if (local(second)) {
                errors.push({
                    message: l10n.t(
                        "'{0}' is a second physics component, and a bullet takes one. The game throws as it is set.",
                        second.name
                    ),
                    node: second.node,
                    severity: 'error',
                });
            }
            continue;
        }

        if (physics.length === 0) {
            const anchor = container.identifier ?? container;
            errors.push({
                message: l10n.t(
                    'This bullet has no physics component. The game throws once it has built the rest of them.'
                ),
                node: anchor,
                severity: 'error',
            });
            continue;
        }

        const physicsIndex = components.indexOf(physics[0]);
        for (let index = 0; index < physicsIndex; index++) {
            const component = components[index];
            if (!NEEDS_PHYSICS_CLASSES.has(component.cls) || !local(component)) continue;
            errors.push({
                message: l10n.t(
                    "'{0}' reads the bullet's physics while it is being built, and '{1}' is written below it, so the game throws on the first shot. Move the physics component above it.",
                    component.name,
                    physics[0].name
                ),
                node: component.node,
                severity: 'error',
            });
        }
    }
    return errors;
};
