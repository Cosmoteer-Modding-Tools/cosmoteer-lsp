/**
 * Type the `cosmoteer.schema.json` import as {@link SchemaBundle} via an ambient module
 * declaration, so the type checker does not infer a giant literal type(`resolveJsonModule` would).
 * The runtime is bundled by esbuild, which inlines the JSON.
 */
declare module '*/cosmoteer.schema.json' {
    import type { SchemaBundle } from './schema.types';
    const bundle: SchemaBundle;
    export default bundle;
}

declare module '*/cosmoteer.schema.previous.json' {
    import type { SchemaReleaseDelta } from './schema.types';
    const delta: SchemaReleaseDelta;
    export default delta;
}
