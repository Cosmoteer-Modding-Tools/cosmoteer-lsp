import { describe, expect, it } from 'vitest';
import { componentKindName, schema } from '../../../src/document/schema/schema';
import {
    DRAWS,
    STORAGE_MEMBERS_BY_ROLE,
    STORAGE_MEMBERS_NOT_DRAWN,
} from '../../../src/features/part-editor/resource-flow.diagram';

// The engine types every member that names a resource storage, through the interface the slot is
// read with, so the schema can be asked which members move resources rather than the drawing being
// told. That is what this holds the drawing to: the weapons were missing from the resource flow for
// a whole release because their draw is a member of the emitter rather than of a resource
// component, and nothing said so. Now a game update that adds such a member fails here instead.
const STORAGE_KINDS = [
    'Cosmoteer.Ships.Parts.Resources.IResourceStorage',
    'Cosmoteer.Ships.Resources.IResourceConsumerTarget',
];

/** One member the schema types as naming a storage, keyed the way the drawing declares its own. */
const storageMembers = (): string[] => {
    const found = new Set<string>();
    for (const [cls, type] of Object.entries(schema.types)) {
        for (const field of type.fields) {
            const kind = field.expectedComponent?.kind;
            if (kind === undefined || !STORAGE_KINDS.includes(componentKindName(kind) ?? '')) continue;
            // A member written as the entries of a list belongs to the class declaring the list, not
            // to the entry class the schema names it under.
            found.add(`${cls.split('/')[0]}.${field.name}`);
        }
    }
    return [...found].sort();
};

const declared = (): Set<string> =>
    new Set([...DRAWS.map((draw) => `${draw.cls}.${draw.storage}`), ...STORAGE_MEMBERS_BY_ROLE]);

describe('resource flow covers every storage member the schema knows', () => {
    it('draws an arrow for each of them, or says why it does not', () => {
        const drawn = declared();
        const unaccounted = storageMembers().filter(
            (member) => !drawn.has(member) && !STORAGE_MEMBERS_NOT_DRAWN.has(member)
        );
        expect(unaccounted).toEqual([]);
    });

    it('declares no member the schema does not have', () => {
        // The other direction, so a member the game renames is caught rather than quietly never
        // matching anything again.
        const known = new Set(storageMembers());
        const stale = [...declared(), ...STORAGE_MEMBERS_NOT_DRAWN.keys()].filter((member) => !known.has(member));
        expect(stale).toEqual([]);
    });
});
