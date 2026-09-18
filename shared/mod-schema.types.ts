/**
 * What reading the code mods' assemblies into the schema came to. Read by the server that does the
 * reading and by every client that reports it, so both sides share the one declaration.
 */

/** What a code mod schema build found. */
export interface ModSchemaSummary {
    /** Assemblies that were read. */
    assemblies: number;
    /** Types the mods contribute. */
    types: number;
    /** `Type=` discriminators the mods contribute. */
    discriminators: number;
    /** True when the result came from the on-disk cache rather than a fresh extraction. */
    fromCache: boolean;
    /** Assemblies that carried no readable .NET metadata, reported rather than failed on. */
    unreadable: string[];
    /** Fields that picked up the mod author's own doc comment from an assembly's XML doc file. */
    documented: number;
    /** Every assembly discovery found, whether or not it was readable. Not reported to the user:
     *  this is what the file watcher arms itself on, so it never repeats the discovery walk. */
    assemblyPaths: readonly string[];
    /** Set when the user turned the feature off (`codeMods.enabled`), so the client can say so
     *  instead of reporting that no mod was found. Never set by a real build. */
    disabled?: boolean;
}
