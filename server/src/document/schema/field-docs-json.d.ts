/**
 * Type the `field-docs.json` import as {@link FieldDocs} via an ambient module declaration, so the
 * type checker does not infer a giant literal type (`resolveJsonModule` would) and the file stays
 * consistent with the `cosmoteer.schema.json` import pattern. The runtime is bundled by esbuild,
 * which inlines the JSON.
 */
declare module '*/field-docs.json' {
    import type { FieldDocs } from './field-docs';
    const docs: FieldDocs;
    export default docs;
}
