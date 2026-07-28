import { describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import bundle from '../../../src/document/schema/cosmoteer.schema.json';
import { SchemaBundle } from '../../../src/document/schema/schema.types';
import { readAssembly } from '../../../src/features/mod-schema/dotnet-assembly';
import { ModSchemaExtension, extractModSchema, gameSchemaView } from '../../../src/features/mod-schema/extract';
import { applyModFieldDocs, parseXmlDocs, summarize } from '../../../src/features/mod-schema/xml-docs';

// A mod author documents their fields in C#, and with the documentation file enabled the compiler
// ships those summaries next to the assembly. Reading them is what makes a mod's own hover prose
// work, so these pin the parse, the doc-ID matching (which has to bridge OT name and C# member
// name), and the end-to-end path against a real assembly.

describe('summarize', () => {
    it('resolves an inline cref to its short name', () => {
        expect(summarize('See <see cref="T:Cosmoteer.Ships.Parts.PartRules"/> for the owner.')).toBe(
            'See PartRules for the owner.'
        );
    });

    it('resolves a generic cref without its arity tick', () => {
        expect(summarize('A <see cref="T:Cosmoteer.Data.ID`1"/> reference.')).toBe('A ID reference.');
    });

    it('resolves a langword and a paramref', () => {
        expect(summarize('Pass <see langword="true"/> to <paramref name="target"/>.')).toBe('Pass true to target.');
    });

    it('keeps the inner text of container tags and decodes entities', () => {
        expect(summarize('<para>Must be &lt;= 5 &amp; &gt;= 1.</para>')).toBe('Must be <= 5 & >= 1.');
    });

    it('collapses the indentation the compiler leaves in a multi-line summary', () => {
        expect(summarize('\n            How many drones\n            the bay holds.\n            ')).toBe(
            'How many drones the bay holds.'
        );
    });

    it('rewrites C# property phrasing into a direct description', () => {
        expect(summarize('Gets or sets a value indicating whether the bay is active.')).toBe(
            'Whether the bay is active.'
        );
        expect(summarize('Gets the launch interval.')).toBe('The launch interval.');
    });

    it('drops the copy-plumbing boilerplate and capitalizes', () => {
        expect(summarize('the radius. This property is not copied by CopySettingsFrom().')).toBe('The radius.');
    });

    it('returns nothing for an empty summary', () => {
        expect(summarize('   ')).toBe('');
    });
});

describe('parseXmlDocs', () => {
    const xml = `<?xml version="1.0"?>
<doc>
  <assembly><name>ModAsm</name></assembly>
  <members>
    <member name="T:Mod.Thing"><summary>A thing.</summary></member>
    <member name="F:Mod.Thing.Count"><summary>How many.</summary></member>
    <member name="P:Mod.Thing.Enabled">
      <summary>Gets or sets a value indicating whether it runs.</summary>
      <remarks>Ignored.</remarks>
    </member>
    <member name="F:Mod.Thing.Undocumented"><remarks>No summary here.</remarks></member>
  </members>
</doc>`;

    it('indexes every documented member by its doc id', () => {
        const docs = parseXmlDocs(xml);
        expect(docs.get('F:Mod.Thing.Count')).toBe('How many.');
        expect(docs.get('P:Mod.Thing.Enabled')).toBe('Whether it runs.');
        expect(docs.get('T:Mod.Thing')).toBe('A thing.');
    });

    it('skips a member with no summary and never invents one', () => {
        expect(parseXmlDocs(xml).has('F:Mod.Thing.Undocumented')).toBe(false);
    });

    it('survives a file that is not XML at all', () => {
        expect(parseXmlDocs('not xml').size).toBe(0);
    });
});

describe('applyModFieldDocs', () => {
    /** A minimal extension carrying one type with three fields, one of them aliased. */
    const extensionWith = (): ModSchemaExtension => ({
        types: {
            'Mod.Thing': {
                name: 'Thing',
                namespace: 'Mod',
                fields: [
                    { name: 'Count', valueType: { kind: 'int' }, optional: true },
                    { name: 'Enabled', valueType: { kind: 'bool' }, optional: true },
                    { name: 'Radius', valueType: { kind: 'float' }, optional: true },
                ],
            },
        },
        enums: {},
        registries: {},
        registryMembers: {},
        assemblyOf: { 'Mod.Thing': 'C:/mods/ModAsm.dll' },
        // `Radius` is written under that name but declared as the C# member `_radius`.
        memberNames: { 'Mod.Thing': { Count: 'Count', Enabled: 'Enabled', Radius: '_radius' } },
    });

    const docs = new Map([
        ['C:/mods/ModAsm.dll', parseXmlDocs(`<doc><members>
            <member name="F:Mod.Thing.Count"><summary>How many.</summary></member>
            <member name="P:Mod.Thing.Enabled"><summary>Whether it runs.</summary></member>
            <member name="F:Mod.Thing._radius"><summary>The radius.</summary></member>
        </members></doc>`)],
    ]);

    it('attaches a field doc, a property doc, and one keyed by the aliased member name', () => {
        const extension = extensionWith();
        expect(applyModFieldDocs(extension, docs)).toBe(3);
        const fields = extension.types['Mod.Thing'].fields;
        expect(fields.map((f) => f.description)).toEqual(['How many.', 'Whether it runs.', 'The radius.']);
    });

    it('does not attach docs from another assembly', () => {
        const extension = extensionWith();
        extension.assemblyOf['Mod.Thing'] = 'C:/mods/OtherAsm.dll';
        expect(applyModFieldDocs(extension, docs)).toBe(0);
        expect(extension.types['Mod.Thing'].fields.every((f) => f.description === undefined)).toBe(true);
    });

    it('is a no-op when the author shipped no documentation file', () => {
        const extension = extensionWith();
        expect(applyModFieldDocs(extension, new Map())).toBe(0);
    });
});

// End to end over a REAL code-mod assembly: the extraction reads the assembly, the doc pass reads
// the XML file beside it, and the author's prose lands on the extracted field. Self-skips without an
// installed code mod. The assembly is copied to a temp folder and the XML written next to the copy,
// so the installed mod is only ever read.
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';

/** The first installed mod assembly, or undefined when no code mod is installed. */
const anyModAssembly = (): string | undefined => {
    if (!existsSync(MODS_DIR)) return undefined;
    for (const entry of readdirSync(MODS_DIR)) {
        const modDir = join(MODS_DIR, entry);
        if (!statSync(modDir).isDirectory()) continue;
        for (const file of readdirSync(modDir)) {
            if (file.toLowerCase().endsWith('.dll')) return join(modDir, file);
        }
    }
    return undefined;
};

const REAL_DLL = anyModAssembly();

describe.skipIf(!REAL_DLL)('a mod assembly with a documentation file', () => {
    it("shows the author's own doc comment on the extracted field", () => {
        const dll = REAL_DLL as string;
        const dir = join(tmpdir(), 'cosmoteer-mod-schema-xmldocs');
        mkdirSync(dir, { recursive: true });
        const copy = join(dir, 'ModUnderTest.dll');
        copyFileSync(dll, copy);

        const assembly = readAssembly(copy, readFileSync(copy));
        expect(assembly).toBeDefined();
        const extension = extractModSchema([assembly!], gameSchemaView(bundle as SchemaBundle));
        const documentedType = Object.keys(extension.types)[0];
        expect(documentedType).toBeDefined();
        const field = extension.types[documentedType].fields[0];
        expect(field).toBeDefined();
        expect(field.description).toBeUndefined();

        // The compiler writes exactly this shape when the author enables the documentation file.
        const member = extension.memberNames[documentedType]?.[field.name] ?? field.name;
        writeFileSync(
            join(dir, 'ModUnderTest.xml'),
            `<?xml version="1.0"?><doc><members>
                <member name="F:${documentedType.replace(/\//g, '.')}.${member}">
                    <summary>Gets or sets a value indicating whether the drones launch.</summary>
                </member>
            </members></doc>`,
            'utf8'
        );

        const docs = new Map([[copy, parseXmlDocs(readFileSync(join(dir, 'ModUnderTest.xml'), 'utf8'))]]);
        expect(applyModFieldDocs(extension, docs)).toBe(1);
        expect(extension.types[documentedType].fields[0].description).toBe('Whether the drones launch.');
    });
});
