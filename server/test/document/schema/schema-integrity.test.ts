import { describe, expect, it } from 'vitest';
import bundle from '../../../src/document/schema/cosmoteer.schema.json';
import { applySchemaOverlay } from '../../../src/document/schema/schema-overlay';
import { SchemaBundle, ValueType } from '../../../src/document/schema/schema.types';

// Structural self-consistency of the SHIPPED schema (bundle + the hand-authored overlay the runtime
// merges in). Every internal cross-link a feature dereferences at runtime — a group/groupForm class,
// an enum, a registry and its members, an `extends` base — must point at something that actually
// exists in the bundle. A dangling link means completion/hover/validation silently resolve nothing
// (a curated `groupForm` pointing at a pruned type, a registry member dropped by the reachability
// prune, a renamed enum). This runs with no game install, so it guards every schema regeneration.
const schema = applySchemaOverlay(bundle as unknown as SchemaBundle);
const types = new Set(Object.keys(schema.types));
const enums = new Set(Object.keys(schema.enums));
const registries = new Set(Object.keys(schema.registries));

/** Every (location, valueType) pair in the schema, flattened depth-first through nested types. */
const allValueTypes: Array<{ where: string; vt: ValueType }> = [];
const walk = (vt: ValueType, where: string): void => {
    allValueTypes.push({ where, vt });
    const v = vt as Record<string, unknown>;
    for (const key of ['element', 'key', 'value'] as const) {
        if (v[key]) walk(v[key] as ValueType, where);
    }
    for (const e of (v.elements as ValueType[]) ?? []) walk(e, where);
    for (const p of (v.params as Array<{ valueType: ValueType }>) ?? []) walk(p.valueType, where);
    for (const a of (v.args as ValueType[]) ?? []) walk(a, where);
};
for (const [cls, def] of Object.entries(schema.types)) {
    for (const field of def.fields) walk(field.valueType, `${cls}.${field.name}`);
}

const danglingOf = (kind: ValueType['kind'], refKey: string, universe: Set<string>): string[] =>
    allValueTypes
        .filter(({ vt }) => vt.kind === kind && (vt as Record<string, unknown>)[refKey])
        .map(({ where, vt }) => ({ where, ref: (vt as Record<string, string>)[refKey] }))
        .filter(({ ref }) => !universe.has(ref))
        .map(({ where, ref }) => `${where} → ${ref}`);

describe('schema integrity — every internal reference resolves', () => {
    it('group / polymorphicGroup value types point at a known type or registry', () => {
        expect(danglingOf('group', 'ref', types)).toEqual([]);
        // a polymorphic slot resolves through schema.registries at runtime
        expect(danglingOf('polymorphicGroup', 'ref', registries)).toEqual([]);
    });

    it('enum value types point at a known enum', () => {
        expect(danglingOf('enum', 'ref', enums)).toEqual([]);
    });

    it('scalar group-form (dual-form Modifiable/Texture) points at a known type', () => {
        const dangling = [
            ...danglingOf('number', 'groupForm', types),
            ...danglingOf('int', 'groupForm', types),
            ...danglingOf('float', 'groupForm', types),
        ];
        expect(dangling).toEqual([]);
    });

    it('every type `extends` a known base', () => {
        const dangling = Object.entries(schema.types)
            .filter(([, t]) => t.extends && !types.has(t.extends))
            .map(([cls, t]) => `${cls} → ${t.extends}`);
        expect(dangling).toEqual([]);
    });

    it('every registry member resolves to a known class', () => {
        const dangling: string[] = [];
        for (const [key, registry] of Object.entries(schema.registries)) {
            for (const [disc, cls] of Object.entries(registry.members)) {
                if (!types.has(cls)) dangling.push(`${key}[${disc}] → ${cls}`);
            }
        }
        expect(dangling).toEqual([]);
    });

    it('the curated dual-form types are present and well-formed', () => {
        // Guards the specific curations features depend on by name.
        for (const fullName of ['Cosmoteer.Ships.ModifiableValue', 'Halfling.Graphics.Texture']) {
            const t = schema.types[fullName];
            expect(t, `${fullName} missing`).toBeDefined();
            expect(t.fields.length).toBeGreaterThan(0);
        }
        expect(schema.enums['Cosmoteer.Ships.ValueModificationMode']?.members).toContain('Multiply');
    });
});
