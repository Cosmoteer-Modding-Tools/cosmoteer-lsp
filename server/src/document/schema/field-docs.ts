/**
 * Community-maintained prose documentation for schema fields, merged onto the extracted bundle at
 * load so it flows into hover and field-name completion (see {@link fieldSignatureMarkdown}).
 *
 * schemagen extracts only structure (types, defaults, enums) — never prose. Human-readable field
 * descriptions live in `docs/fields/<FullType>.md` (the editable source of truth, one `## <field>`
 * heading per field) and are compiled to `field-docs.json` by the docs scaffolder. Keeping the store
 * separate from `cosmoteer.schema.json` means a schemagen regen after a Cosmoteer update never
 * clobbers hand-written docs.
 *
 * The map is keyed by class C# FullName → field OT name → description. A description attaches to the
 * field on the class that declares it; because {@link fieldsOf} walks the inheritance chain, a
 * documented base-class field shows its description on every derived class too.
 */
import docs from './field-docs.json';
import { SchemaBundle } from './schema.types';

/** class FullName → (field name → prose description). */
export type FieldDocs = Record<string, Record<string, string>>;

/**
 * Attach prose descriptions to the fields of an already-loaded bundle. A description is matched to a
 * field by its primary name or any alias, so docs stay valid across `[Serialize]` alias spellings.
 * Mutates and returns `bundle`. Unknown types/fields in the docs are ignored (the lint flags those).
 * @param bundle The schema bundle to annotate in place.
 * @param fieldDocs The documentation map; defaults to the bundled `field-docs.json`.
 * @returns The same bundle, with `description` set on documented fields.
 */
export const applyFieldDocs = (bundle: SchemaBundle, fieldDocs: FieldDocs = docs): SchemaBundle => {
    for (const [fullName, fields] of Object.entries(fieldDocs)) {
        const type = bundle.types[fullName];
        if (!type) continue;
        for (const field of type.fields) {
            const desc = fields[field.name] ?? field.aliases?.map((a) => fields[a]).find(Boolean);
            if (desc) field.description = desc;
        }
    }
    return bundle;
};
