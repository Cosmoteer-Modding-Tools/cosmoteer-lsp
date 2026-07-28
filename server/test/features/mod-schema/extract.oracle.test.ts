import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import bundle from '../../../src/document/schema/cosmoteer.schema.json';
import { SchemaBundle } from '../../../src/document/schema/schema.types';
import { readAssembly } from '../../../src/features/mod-schema/dotnet-assembly';
import { extractModSchema, gameSchemaView } from '../../../src/features/mod-schema/extract';
import { parseXmlDocs } from '../../../src/features/mod-schema/xml-docs';

// The extraction of a code mod's schema surface is a port of `tools/schemagen --mod`, the C# tool
// that produces the shipped bundle, onto a TypeScript metadata reader so no .NET runtime is needed
// at run time. Two implementations of the same rules drift silently, so this pins them against each
// other: schemagen runs over the same mod assemblies and its output is the expected value for every
// type, enum and registry member the mod declares.
//
// It self-skips unless the machine can produce that oracle: a Cosmoteer install, the .NET SDK, and
// at least one installed workshop mod that ships a `.dll`. Override the inputs with
// COSMOTEER_BIN_DIR, COSMOTEER_MODS_DIR, or point COSMOTEER_MOD_SCHEMA_ORACLE at an already-built
// schemagen output to skip the (slow) generation step.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const BIN_DIR = process.env.COSMOTEER_BIN_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Bin';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';

/** Every `.dll` a mod folder ships, which is what makes it a code mod. */
const modAssemblies = (): string[] => {
    if (!existsSync(MODS_DIR)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(MODS_DIR)) {
        const modDir = join(MODS_DIR, entry);
        if (!statSync(modDir).isDirectory()) continue;
        for (const file of readdirSync(modDir)) {
            if (file.toLowerCase().endsWith('.dll')) out.push(join(modDir, file));
        }
    }
    return out;
};

/** Whether the .NET SDK needed to run schemagen is on PATH. */
const haveDotnet = (): boolean => {
    try {
        execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

const DLLS = modAssemblies();
const HAVE = existsSync(BIN_DIR) && DLLS.length > 0 && (haveDotnet() || !!process.env.COSMOTEER_MOD_SCHEMA_ORACLE);

/**
 * The schemagen output for the same assemblies, generated on demand and reused across runs while
 * the inputs are unchanged.
 *
 * @param dlls the mod assemblies to extract.
 * @returns the oracle bundle.
 */
const oracleBundle = (dlls: string[]): SchemaBundle => JSON.parse(readFileSync(oraclePath(dlls), 'utf8')) as SchemaBundle;

/**
 * The path of the schemagen output, generating it when it is not already there.
 *
 * @param dlls the mod assemblies to extract.
 * @returns the output path. `field-docs.seed.json`, schemagen's prose seed, sits beside it.
 */
const oraclePath = (dlls: string[]): string => {
    const preBuilt = process.env.COSMOTEER_MOD_SCHEMA_ORACLE;
    if (preBuilt) return preBuilt;
    const stamp = dlls.map((dll) => `${dll}:${statSync(dll).mtimeMs}`).join('|');
    const key = Buffer.from(stamp).toString('base64url').slice(-40);
    const outDir = join(tmpdir(), 'cosmoteer-mod-schema-oracle', key);
    const outPath = join(outDir, 'oracle.schema.json');
    if (!existsSync(outPath)) {
        mkdirSync(outDir, { recursive: true });
        const args = ['run', '-c', 'Release', '--project', join(repoRoot, 'tools', 'schemagen'), '--', BIN_DIR, outPath];
        for (const dll of dlls) args.push('--mod', dll);
        execFileSync('dotnet', args, { stdio: 'ignore', timeout: 600_000 });
    }
    return outPath;
};

/** The extraction's own output over the same assemblies. */
const extracted = (dlls: string[]) => {
    const assemblies = dlls
        .map((dll) => readAssembly(dll, readFileSync(dll)))
        .filter((assembly): assembly is NonNullable<typeof assembly> => assembly !== undefined);
    return { assemblies, result: extractModSchema(assemblies, gameSchemaView(bundle as SchemaBundle)) };
};

describe.skipIf(!HAVE)('mod schema extraction matches schemagen', () => {
    it('extracts the same types, enums and discriminators for every installed code mod', () => {
        const oracle = oracleBundle(DLLS);
        const { assemblies, result } = extracted(DLLS);
        expect(assemblies.length).toBe(DLLS.length);

        // Every type the mod assemblies declare, which is what the two runs must agree on. The
        // oracle also carries the whole game schema, which this extraction deliberately does not
        // reproduce, so the comparison is scoped to the mod's own namespaces.
        const modNamespaces = new Set(assemblies.flatMap((a) => a.types.map((t) => t.fullName)));
        const oracleTypes = Object.fromEntries(
            Object.entries(oracle.types).filter(([fullName]) => modNamespaces.has(fullName))
        );
        expect(Object.keys(oracleTypes).length).toBeGreaterThan(0);
        expect(Object.keys(result.types).sort()).toEqual(Object.keys(oracleTypes).sort());
        for (const fullName of Object.keys(oracleTypes)) {
            expect({ [fullName]: result.types[fullName] }).toEqual({ [fullName]: oracleTypes[fullName] });
        }

        const oracleEnums = Object.fromEntries(
            Object.entries(oracle.enums).filter(([fullName]) => modNamespaces.has(fullName))
        );
        expect(result.enums).toEqual(oracleEnums);

        // Discriminators: every `Type=` the oracle records for a mod class must be registered under
        // the same registry here, whether the registry is the game's or the mod's own.
        const oracleMembers: Record<string, Record<string, string>> = {};
        for (const [registry, def] of Object.entries(oracle.registries)) {
            for (const [disc, cls] of Object.entries(def.members)) {
                if (!modNamespaces.has(cls)) continue;
                (oracleMembers[registry] ??= {})[disc] = cls;
            }
        }
        const ourMembers: Record<string, Record<string, string>> = { ...structuredClone(result.registryMembers) };
        for (const [registry, def] of Object.entries(result.registries)) {
            if (Object.keys(def.members).length > 0) ourMembers[registry] = { ...def.members };
        }
        expect(ourMembers).toEqual(oracleMembers);
    }, 900_000);

    // The prose side of the same contract. A mod author's `///` comments reach hover only if this
    // reader renders a `<summary>` the way schemagen's does, and the game's own XML doc files are a
    // large real corpus of every shape that occurs (crefs, langwords, `<para>`, the C# property
    // phrasing). schemagen's seed is the expected rendering.
    it('renders XML doc summaries the way schemagen does', () => {
        const seedPath = join(dirname(oraclePath(DLLS)), 'field-docs.seed.json');
        if (!existsSync(seedPath)) {
            console.log('SKIP: no field-docs.seed.json beside the oracle output');
            return;
        }
        const ours = new Set<string>();
        for (const assembly of ['Cosmoteer.xml', 'HalflingCore.xml']) {
            const xmlPath = join(BIN_DIR, assembly);
            if (!existsSync(xmlPath)) continue;
            for (const summary of parseXmlDocs(readFileSync(xmlPath, 'utf8')).values()) ours.add(summary);
        }
        expect(ours.size).toBeGreaterThan(500);
        const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Record<string, Record<string, string>>;
        const missing: string[] = [];
        let checked = 0;
        for (const fields of Object.values(seed)) {
            for (const summary of Object.values(fields)) {
                checked++;
                if (!ours.has(summary)) missing.push(summary);
            }
        }
        expect(checked).toBeGreaterThan(500);
        expect(missing.slice(0, 10)).toEqual([]);
    }, 300_000);
});
