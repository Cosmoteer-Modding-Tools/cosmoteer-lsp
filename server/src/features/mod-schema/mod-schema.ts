/**
 * The code-mod schema feature: find the assemblies a code mod ships, extract the `.rules` schema
 * surface they add, and merge it into the schema every other feature reads.
 *
 * Discovery covers both places a code mod can be: the folders the user has open, and the installed
 * Steam workshop tree. The installed tree matters because a mod the user is not editing still
 * supplies types the files they are editing legitimately name, which is the case that produced
 * unknown-discriminator false positives before this existed.
 *
 * Extraction is not free (each assembly is read and its metadata walked), so the result is cached
 * on disk keyed by the exact assemblies that went into it. A later session with the same mods
 * installed loads the cache and merges it with no parsing at all, which is what makes the feature
 * usable without the user re-running anything.
 */
import { readFile, stat, writeFile, mkdir, rename } from 'fs/promises';
import { dirname, join } from 'path';
import { readdir } from 'fs/promises';
import { CancellationToken } from 'vscode-languageserver';
import bundle from '../../document/schema/cosmoteer.schema.json';
import { SchemaBundle } from '../../document/schema/schema.types';
import { extendSchemaWithMods } from '../../document/schema/schema';
import { cacheArtifactPath, currentServerBuildId } from '../../workspace/index-cache';
import { readAssembly } from './dotnet-assembly';
import { ModSchemaExtension, extractModSchema, gameSchemaView } from './extract';
import { XmlDocs, applyModFieldDocs, readXmlDocsFor, xmlDocPathFor } from './xml-docs';
import { workshopLinkFor } from './workshop-link';

/**
 * The `workspace/executeCommand` id both clients invoke to (re)build the code-mod schema. Present
 * as a command as well as an automatic startup load so a user who just built or installed a mod can
 * pick up its new types without restarting.
 */
export const BUILD_MOD_SCHEMA_COMMAND = 'cosmoteer.buildModSchema';

/** Bump when the extension's serialized shape changes, so an older cache is discarded not misread.
 *  v2: the extension gained the per-type assembly map, the member-name map, and the field prose
 *  read from each assembly's XML doc file.
 *  v3: it gained the per-assembly workshop link the hover footer points at. */
const CACHE_FORMAT_VERSION = 3;

/** Directories that never hold a mod assembly and are expensive to walk. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.vs', '.idea', 'obj', '.vscode-test']);

/**
 * How deep the walk looks for assemblies. Deep enough for a mod's own build output
 * (`bin/Release/net10.0/mod.dll`) and for a workshop mod that tucks its assembly in a subfolder,
 * shallow enough that the whole installed workshop tree stays a fraction of a second to reject.
 */
const MAX_WALK_DEPTH = 5;

/** One discovered assembly with the stat that decides whether a cached extraction still applies. */
interface AssemblyStamp {
    path: string;
    size: number;
    mtimeMs: number;
    /** The XML doc file beside it, when the author shipped one. Its prose is part of the extraction,
     *  so a doc file added or edited beside an unchanged assembly must miss the cache too. */
    doc?: { size: number; mtimeMs: number };
}

/** What a build produced, for the client to report. */
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

/** The serialized cache file. */
interface ModSchemaCache {
    version: number;
    serverBuildId: string;
    assemblies: AssemblyStamp[];
    extension: ModSchemaExtension;
}

/**
 * Walk a folder for `.dll` files, skipping the directories that never hold one.
 *
 * @param root the folder to walk.
 * @param depth how many levels are left to descend.
 * @param out collects the discovered paths.
 * @returns once the walk finished. An unreadable directory is skipped, never thrown from.
 */
const walkForAssemblies = async (root: string, depth: number, out: string[]): Promise<void> => {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (depth <= 0 || SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
            await walkForAssemblies(join(root, entry.name), depth - 1, out);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
            out.push(join(root, entry.name));
        }
    }
};

/**
 * Every assembly a code mod could have contributed, from the open workspace folders and the
 * installed workshop tree, with the stat that identifies each.
 *
 * @param roots folders to search: the workspace folders plus the workshop content directory.
 * @returns the discovered assemblies, sorted by path so a cache key is stable.
 */
export const discoverModAssemblies = async (roots: readonly string[]): Promise<AssemblyStamp[]> => {
    const paths: string[] = [];
    for (const root of roots) await walkForAssemblies(root, MAX_WALK_DEPTH, paths);
    const unique = [...new Set(paths)].sort();
    const stamps: AssemblyStamp[] = [];
    for (const path of unique) {
        try {
            const info = await stat(path);
            stamps.push({ path, size: info.size, mtimeMs: info.mtimeMs, doc: await docStamp(path) });
        } catch {
            // Vanished between the walk and the stat, so it is not part of this build.
        }
    }
    return stamps;
};

/**
 * The stat of the XML doc file beside an assembly.
 *
 * @param assemblyPath the assembly.
 * @returns its doc file's size and mtime, or undefined when the author shipped none.
 */
const docStamp = async (assemblyPath: string): Promise<{ size: number; mtimeMs: number } | undefined> => {
    const docPath = xmlDocPathFor(assemblyPath);
    if (!docPath) return undefined;
    try {
        const info = await stat(docPath);
        return { size: info.size, mtimeMs: info.mtimeMs };
    } catch {
        return undefined;
    }
};

/** Whether two assembly sets are the same files, with the same doc files, at the same sizes and times. */
const sameAssemblies = (a: readonly AssemblyStamp[], b: readonly AssemblyStamp[]): boolean =>
    a.length === b.length &&
    a.every((left, index) => {
        const right = b[index];
        return (
            left.path === right.path &&
            left.size === right.size &&
            left.mtimeMs === right.mtimeMs &&
            left.doc?.size === right.doc?.size &&
            left.doc?.mtimeMs === right.doc?.mtimeMs
        );
    });

/**
 * Read and extract a set of assemblies.
 *
 * @param stamps the assemblies to read.
 * @param cancellationToken abandons the extraction between assemblies.
 * @returns the merged extension and the assemblies that carried no readable metadata.
 */
const extractFrom = async (
    stamps: readonly AssemblyStamp[],
    cancellationToken: CancellationToken
): Promise<{ extension: ModSchemaExtension; unreadable: string[]; read: number; documented: number }> => {
    const assemblies = [];
    const unreadable: string[] = [];
    const docsByAssembly = new Map<string, XmlDocs>();
    const links = new Map<string, { url: string; name?: string }>();
    for (const stamp of stamps) {
        if (cancellationToken.isCancellationRequested) break;
        try {
            const assembly = readAssembly(stamp.path, await readFile(stamp.path));
            // Most `.dll` files near a mod are not managed assemblies at all (a native dependency,
            // a shipped tool). Those are not an error, they simply contribute nothing.
            if (assembly) {
                assemblies.push(assembly);
                docsByAssembly.set(stamp.path, await readXmlDocsFor(stamp.path));
                const link = await workshopLinkFor(stamp.path);
                if (link) links.set(stamp.path, link);
            } else unreadable.push(stamp.path);
        } catch {
            unreadable.push(stamp.path);
        }
    }
    const extension = extractModSchema(assemblies, gameSchemaView(bundle as SchemaBundle));
    // The author's own doc comments, applied after extraction so the extraction itself stays
    // comparable to schemagen's output (which emits prose to a separate seed file, never inline).
    const documented = applyModFieldDocs(extension, docsByAssembly);
    // Only the assemblies that actually contributed a type need a link, so a native dependency
    // sitting in the same folder never puts its mod's page on anything.
    for (const assemblyPath of new Set(Object.values(extension.assemblyOf))) {
        const link = links.get(assemblyPath);
        if (link) extension.modLinks[assemblyPath] = link;
    }
    return { extension, unreadable, read: assemblies.length, documented };
};

/** The cache file for a game Data root. */
const cachePath = (dataRoot: string): string => cacheArtifactPath(dataRoot, 'mod-schema-cache');

/**
 * Load a cached extraction, when one matches the assemblies currently on disk.
 *
 * @param dataRoot the game `Data` root the cache is keyed by.
 * @param stamps the assemblies discovered now.
 * @returns the cached extension, or undefined when there is no usable cache.
 */
const loadCache = async (dataRoot: string, stamps: readonly AssemblyStamp[]): Promise<ModSchemaExtension | undefined> => {
    try {
        const cache = JSON.parse(await readFile(cachePath(dataRoot), 'utf8')) as ModSchemaCache;
        if (cache.version !== CACHE_FORMAT_VERSION) return undefined;
        if (cache.serverBuildId !== currentServerBuildId()) return undefined;
        if (!sameAssemblies(cache.assemblies, stamps)) return undefined;
        return cache.extension;
    } catch {
        return undefined;
    }
};

/**
 * Write the extraction to the cache, so the next session merges it without reading any assembly.
 *
 * @param dataRoot the game `Data` root the cache is keyed by.
 * @param stamps the assemblies the extension came from.
 * @param extension what to cache.
 * @returns once written, or silently on any write failure. A missing cache only costs time.
 */
const saveCache = async (
    dataRoot: string,
    stamps: readonly AssemblyStamp[],
    extension: ModSchemaExtension
): Promise<void> => {
    const cache: ModSchemaCache = {
        version: CACHE_FORMAT_VERSION,
        serverBuildId: currentServerBuildId(),
        assemblies: [...stamps],
        extension,
    };
    const path = cachePath(dataRoot);
    const temp = `${path}.${process.pid}.tmp`;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temp, JSON.stringify(cache), 'utf8');
        await rename(temp, path);
    } catch {
        /* the cache is an optimization, never a correctness requirement */
    }
};

/**
 * Build (or reuse) the code-mod schema and merge it into the shipped schema.
 *
 * @param roots the folders to search for mod assemblies.
 * @param dataRoot the game `Data` root, which keys the cache.
 * @param options `force` skips the cache and re-reads every assembly, which is what the command
 *                does so a rebuilt mod is picked up even when its timestamp did not move.
 * @param cancellationToken abandons the build.
 * @returns what was merged, for the client to report.
 */
export const buildModSchema = async (
    roots: readonly string[],
    dataRoot: string,
    options: { force?: boolean } = {},
    cancellationToken: CancellationToken = CancellationToken.None
): Promise<ModSchemaSummary> => {
    const stamps = await discoverModAssemblies(roots);
    const assemblyPaths = stamps.map((stamp) => stamp.path);
    if (stamps.length === 0) {
        extendSchemaWithMods(undefined);
        return { assemblies: 0, types: 0, discriminators: 0, fromCache: false, unreadable: [], documented: 0, assemblyPaths };
    }
    const cached = options.force ? undefined : await loadCache(dataRoot, stamps);
    if (cached) {
        extendSchemaWithMods(cached);
        return { ...summarize(cached), assemblies: stamps.length, fromCache: true, unreadable: [], assemblyPaths };
    }
    const { extension, unreadable, read, documented } = await extractFrom(stamps, cancellationToken);
    if (cancellationToken.isCancellationRequested) {
        return { assemblies: 0, types: 0, discriminators: 0, fromCache: false, unreadable: [], documented: 0, assemblyPaths };
    }
    extendSchemaWithMods(extension);
    await saveCache(dataRoot, stamps, extension);
    return { ...summarize(extension), assemblies: read, fromCache: false, unreadable, documented, assemblyPaths };
};

/** The counts a summary reports, derived from the extension itself. */
const summarize = (
    extension: ModSchemaExtension
): Omit<ModSchemaSummary, 'assemblies' | 'fromCache' | 'unreadable' | 'assemblyPaths'> => {
    let discriminators = 0;
    let documented = 0;
    for (const members of Object.values(extension.registryMembers)) discriminators += Object.keys(members).length;
    for (const registry of Object.values(extension.registries)) discriminators += Object.keys(registry.members).length;
    for (const type of Object.values(extension.types)) {
        documented += type.fields.filter((field) => field.description).length;
    }
    return { types: Object.keys(extension.types).length, discriminators, documented };
};
