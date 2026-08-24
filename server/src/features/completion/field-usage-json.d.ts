/**
 * Type the `field-usage.json` import as {@link FieldUsage} via an ambient module declaration, so
 * the type checker does not infer a giant literal type for a table that only ranks a list. Mirrors
 * the `field-docs.json` declaration next to the schema.
 */
declare module '*/field-usage.json' {
    import type { FieldUsage } from './field-usage';
    const usage: FieldUsage;
    export default usage;
}
