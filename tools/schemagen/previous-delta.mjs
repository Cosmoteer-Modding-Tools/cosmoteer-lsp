// Writes the delta that turns the shipped schema back into the one of the previous game release.
//
// The server ships one schema, extracted from the newest game build. A player still on the release
// before it (a release candidate is out, or they have not updated yet) would be offered fields their
// game does not read and told to drop fields it still reads. This delta holds the previous release's
// definition of every entry that differs, so the server can switch to it when the installed game is
// older. Run it right after regenerating the schema, against the bundle it replaced:
//
//   git show <commit>:server/src/document/schema/cosmoteer.schema.json > previous.json
//   node tools/schemagen/previous-delta.mjs previous.json <previous version> <new version>
//
// <previous version> is what that game build reports (`0.30.4c`), <new version> the release the
// shipped schema belongs to, without a release-candidate suffix (`0.30.5`), since the candidate and
// the final build share a schema.
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const [previousPath, version, replacedBy] = process.argv.slice(2);
if (!previousPath || !version || !replacedBy) {
    console.error('usage: node previous-delta.mjs <previous schema.json> <previous version> <new version>');
    process.exit(1);
}
const schemaDir = join(dirname(fileURLToPath(import.meta.url)), '../../server/src/document/schema');
const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
const current = JSON.parse(readFileSync(join(schemaDir, 'cosmoteer.schema.json'), 'utf8'));
// Extractor output that changed without the game changing, so it is not part of the delta. An empty
// `valueField` stopped being written in 1.1.1, and nothing reads it.
for (const registry of Object.values(previous.registries ?? {})) {
    if (registry.valueField === '') delete registry.valueField;
}

// Keyed sections are diffed entry by entry, null marking an entry the previous release lacks.
// Every other section is small and replaced whole when it differs.
const KEYED = ['types', 'enums', 'registries', 'builtinIds', 'componentCapabilities', 'componentAncestry'];
const delta = { version, replacedBy, keyed: {}, whole: {} };
for (const section of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (section === 'meta' || section === 'unresolved') continue;
    if (KEYED.includes(section)) {
        const before = previous[section] ?? {};
        const after = current[section] ?? {};
        const changed = {};
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed[key] = before[key] ?? null;
        }
        if (Object.keys(changed).length > 0) delta.keyed[section] = changed;
    } else if (JSON.stringify(previous[section]) !== JSON.stringify(current[section])) {
        delta.whole[section] = previous[section] ?? null;
    }
}
writeFileSync(join(schemaDir, 'cosmoteer.schema.previous.json'), JSON.stringify(delta, null, 2) + '\n');
const counts = Object.entries(delta.keyed).map(([section, entries]) => `${Object.keys(entries).length} ${section}`);
console.log(`delta ${version} <- ${replacedBy}: ${[...counts, ...Object.keys(delta.whole)].join(', ')}`);
