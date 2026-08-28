/**
 * Community-maintained prose documentation for schema classes and their fields, merged onto the
 * extracted bundle at load so it flows into hover, field-name completion (see
 * {@link fieldSignatureMarkdown}) and the class pages of the schema search.
 *
 * schemagen extracts only structure (types, defaults, enums), never prose. Human-readable
 * descriptions live in `docs/fields/<FullType>.md` (the editable source of truth, one class summary
 * at the top and one `## <field>` heading per field) and are compiled to `field-docs.json` by the
 * docs scaffolder. Keeping the store separate from `cosmoteer.schema.json` means a schemagen regen
 * after a Cosmoteer update never clobbers hand-written docs.
 *
 * The map is keyed by class C# FullName → field OT name → description, with the class's own summary
 * under {@link CLASS_DOC_KEY}. A description attaches to the field on the class that declares it.
 * Because {@link fieldsOf} walks the inheritance chain, a documented base-class field shows its
 * description on every derived class too. A class summary does not inherit: a derived class with no
 * summary of its own says nothing rather than borrowing its base's sentence.
 */
import docs from './field-docs.json';
import { SchemaBundle } from './schema.types';

/** class FullName → (field name → prose description). */
export type FieldDocs = Record<string, Record<string, string>>;

/**
 * The reserved key a class summary sits under, alongside that class's field prose. It borrows the
 * XML doc-ID prefix for a type, and no serialized field name can collide with it. Mirrored by
 * `CLASS_KEY` in `tools/docsgen/docsgen.mjs` and by `CLASSDOC` in schemagen.
 */
export const CLASS_DOC_KEY = 'T:';

/**
 * Attach prose descriptions to an already-loaded bundle: the class summary to the type and to the
 * registry of the same FullName, and each field description to its field. A field description is
 * matched by its primary name or any alias, so docs stay valid across `[Serialize]` alias spellings.
 * Mutates and returns `bundle`. Unknown types/fields in the docs are ignored (the lint flags those).
 * @param bundle The schema bundle to annotate in place.
 * @param fieldDocs The documentation map; defaults to the bundled `field-docs.json`.
 * @returns The same bundle, with `description` set on documented classes and fields.
 */
export const applyFieldDocs = (bundle: SchemaBundle, fieldDocs: FieldDocs = docs): SchemaBundle => {
    for (const [fullName, entry] of Object.entries(fieldDocs)) {
        const summary = entry[CLASS_DOC_KEY];
        if (summary) {
            // A registry base is usually a class too, and both surfaces render the same sentence.
            if (bundle.types[fullName]) bundle.types[fullName].description = summary;
            if (bundle.registries[fullName]) bundle.registries[fullName].description = summary;
        }
        const type = bundle.types[fullName];
        if (!type) continue;
        for (const field of type.fields) {
            const desc = entry[field.name] ?? field.aliases?.map((a) => entry[a]).find(Boolean);
            if (desc) field.description = desc;
        }
    }
    return bundle;
};
