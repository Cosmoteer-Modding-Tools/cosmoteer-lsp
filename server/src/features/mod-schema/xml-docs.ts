/**
 * Prose field documentation for a code mod, read from the XML doc file the C# compiler emits
 * beside the assembly.
 *
 * The game's own field prose is community-maintained in `docs/fields/*.md` and merged at load
 * (`document/schema/field-docs.ts`). Nobody is going to hand-write that for someone else's mod, but
 * a mod author already documents their own fields where it belongs, in the C# source:
 *
 * ```csharp
 * /// <summary>How many drones the bay can hold at once.</summary>
 * [Serialize(Optional = true)] public int BayMaxDrones = 6;
 * ```
 *
 * With `<GenerateDocumentationFile>true</GenerateDocumentationFile>` the compiler writes those
 * summaries to `<assembly>.xml`, which ships next to the `.dll`. Reading it makes the author's own
 * doc comments show up on hover and completion in their `.rules` files, for free.
 *
 * This mirrors what `tools/schemagen` does with `Cosmoteer.xml` / `HalflingCore.xml`, including the
 * two rewrites that turn C# property phrasing into field documentation, so a mod's prose reads the
 * same way the game's does. The XML doc format is small and rigidly generated, so it is scanned
 * directly rather than through an XML parser dependency the server does not otherwise have.
 */
import { readFile } from 'fs/promises';
import { ModSchemaExtension } from './extract';

/** XML doc-ID (`F:Namespace.Type.Member`) to the readable text of its `<summary>`. */
export type XmlDocs = ReadonlyMap<string, string>;

/** One `<member name="…">…</member>` entry. */
const MEMBER = /<member\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/member>/g;
/** The `<summary>` inside a member entry. */
const SUMMARY = /<summary\s*>([\s\S]*?)<\/summary>/;
/** A `<see cref="T:Ns.Type"/>` or `<seealso …>` reference, whose short name is the readable text. */
const CREF = /<(?:see|seealso)\b[^>]*?(?:cref|langword)\s*=\s*"([^"]*)"[^>]*\/?>/g;
/** A `<paramref name="x"/>` or `<typeparamref …>`, whose name is the readable text. */
const PARAMREF = /<(?:paramref|typeparamref)\b[^>]*?name\s*=\s*"([^"]*)"[^>]*\/?>/g;
/** Any remaining tag, dropped while keeping the inner text of container tags like `<para>`. */
const ANY_TAG = /<[^>]*>/g;

/** The five entities the compiler escapes in a doc comment. */
const ENTITIES: Record<string, string> = {
    '&lt;': '<',
    '&gt;': '>',
    '&amp;': '&',
    '&quot;': '"',
    '&apos;': "'",
};

/**
 * The short name a `cref` refers to: `T:Cosmoteer.Ships.PartRules` reads as `PartRules`.
 *
 * @param cref the raw cref or langword value.
 * @returns the readable short name.
 */
const crefShortName = (cref: string): string => {
    const colon = cref.indexOf(':');
    let name = colon >= 0 ? cref.slice(colon + 1) : cref;
    const tick = name.indexOf('`');
    if (tick >= 0) name = name.slice(0, tick);
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1) : name;
};

/**
 * The readable text of a `<summary>` body: inline references become their short names, remaining
 * tags are dropped, whitespace collapses, and the C# property phrasing is rewritten into a direct
 * description the way it reads as field documentation.
 *
 * @param body the raw inner XML of the summary.
 * @returns the readable text, empty when the summary carries nothing.
 */
export const summarize = (body: string): string => {
    let text = body
        .replace(CREF, (_match, cref: string) => crefShortName(cref))
        .replace(PARAMREF, (_match, name: string) => name)
        .replace(ANY_TAG, '');
    text = text.replace(/&(?:lt|gt|amp|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
    text = text.replace(/\s+/g, ' ').trim();
    // Written for engine developers: drop the C# copy-plumbing boilerplate, which means nothing in
    // a `.rules` file, and turn `Gets or sets whether …` into `Whether …`.
    text = text.replace(/\s*This (?:property|member) [^.]*?CopySettingsFrom\(\)[^.]*\.?/g, '');
    text = text.replace(/^Gets(?: or sets)? a value indicating whether /, 'Whether ');
    text = text.replace(/^Gets(?: or sets)? /, '');
    text = text.trim();
    return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
};

/**
 * Parse an XML documentation file into doc-ID to summary.
 *
 * @param xml the file's text.
 * @returns every documented member. The first entry wins on a duplicate id, as the compiler emits
 *          at most one per member anyway.
 */
export const parseXmlDocs = (xml: string): XmlDocs => {
    const docs = new Map<string, string>();
    for (const match of xml.matchAll(MEMBER)) {
        const id = match[1];
        const summary = SUMMARY.exec(match[2]);
        if (!summary || docs.has(id)) continue;
        const text = summarize(summary[1]);
        if (text) docs.set(id, text);
    }
    return docs;
};

/**
 * The XML doc file the compiler writes beside an assembly.
 *
 * @param assemblyPath the `.dll` path.
 * @returns the doc file's path, or undefined when the path is not an assembly.
 */
export const xmlDocPathFor = (assemblyPath: string): string | undefined => {
    const xmlPath = assemblyPath.replace(/\.dll$/i, '.xml');
    return xmlPath === assemblyPath ? undefined : xmlPath;
};

/**
 * Read the XML doc file sitting beside an assembly.
 *
 * @param assemblyPath the `.dll` path.
 * @returns its documented members, empty when the author did not enable the documentation file or
 *          the file cannot be read.
 */
export const readXmlDocsFor = async (assemblyPath: string): Promise<XmlDocs> => {
    const xmlPath = xmlDocPathFor(assemblyPath);
    if (!xmlPath) return new Map();
    try {
        return parseXmlDocs(await readFile(xmlPath, 'utf8'));
    } catch {
        return new Map();
    }
};

/**
 * Attach a mod's own doc comments to its extracted fields.
 *
 * A field's doc-ID is built from the declaring type and the C# member the field came from, which is
 * not always the field's OT name (a `[Serialize(Alias = …)]` member is written under the alias). The
 * extraction records that mapping for exactly this. Both the field and property spellings are tried,
 * since the compiler keys a field as `F:` and a property as `P:`.
 *
 * @param extension the extraction to annotate in place.
 * @param docsByAssembly the documented members of each assembly, keyed by the assembly's path.
 * @returns how many fields received a description.
 */
export const applyModFieldDocs = (
    extension: ModSchemaExtension,
    docsByAssembly: ReadonlyMap<string, XmlDocs>
): number => {
    let applied = 0;
    for (const [fullName, type] of Object.entries(extension.types)) {
        const docs = docsByAssembly.get(extension.assemblyOf[fullName] ?? '');
        if (!docs || docs.size === 0) continue;
        const members = extension.memberNames[fullName] ?? {};
        // Cecil-style FullNames separate a nested type from its declarer with `/`; a doc-ID uses `.`.
        const typeId = fullName.replace(/\//g, '.');
        for (const field of type.fields) {
            const member = members[field.name] ?? field.name;
            const summary = docs.get(`F:${typeId}.${member}`) ?? docs.get(`P:${typeId}.${member}`);
            if (!summary) continue;
            field.description = summary;
            applied++;
        }
    }
    return applied;
};
