import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { lexer } from '../../src/core/lexer/lexer';
import { parser } from '../../src/core/parser/parser';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../src/core/ast/ast';
import { groupDiscriminator, listSlotType, memberTypeIn, resolveGroupClass } from '../../src/document/schema/schema-context';
import { classByDiscriminator, fieldOf, schema } from '../../src/document/schema/schema';
import { documentRootClass } from '../../src/document/schema/document-root';
import { aliasRootIndex } from '../../src/document/schema/alias-root';
import { ReverseIncludeIndex } from '../../src/features/navigation/reverse-include.index';
import { MemberInjectionIndex } from '../../src/mod/member-injection.index';
import { AddBaseIndex } from '../../src/mod/add-base.index';
import { clearModRootCache } from '../../src/mod/mod-root';
import { invalidateModContext } from '../../src/mod/mod-context';
import { CosmoteerWorkspaceService } from '../../src/workspace/cosmoteer-workspace.service';
import { globalSettings } from '../../src/settings';

// Dark-group audit: classify every group by whether resolveGroupClass finds a class, and when it
// does, whether the class actually fits the group's own field names. "Dark" groups are the ones the
// user experiences as "no hover, no completion" (the `Type = Beam` shot-fragment class of bug), so
// this is the regression net for the whole resolution stack (rooting, slot typing, inheritance-base
// rooting, registry dispatch).
//
// Two suites share the classifier:
//  - The VANILLA GATE always runs when the game install is present. It pins ceilings on every dark
//    cause and a floor on the resolved fraction, so a resolution regression fails loudly here
//    instead of surfacing one confused modder at a time.
//  - The FULL DUMP over vanilla + every installed workshop mod is env-gated (AUDIT_OUT=<report>)
//    and writes the classified findings for triage.

const DATA_DIR = process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data';
const MODS_DIR = process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600';
const OUT = process.env.AUDIT_OUT ?? '';
const HAVE_DATA = existsSync(DATA_DIR);
const HAVE_MODS = !!OUT && HAVE_DATA && existsSync(MODS_DIR);
const token = CancellationToken.None;

const rulesFiles = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            const p = join(dir, entry);
            let s;
            try { s = statSync(p); } catch { continue; }
            if (s.isDirectory()) walk(p);
            else if (entry.endsWith('.rules')) out.push(p);
        }
    };
    walk(root);
    return out;
};

const namedMemberNames = (group: GroupNode): string[] =>
    group.elements
        .map((n) =>
            isAssignmentNode(n) ? n.left.name : isGroupNode(n) || isListNode(n) ? n.identifier?.name : undefined
        )
        .filter((n): n is string => !!n && n.toLowerCase() !== 'type');

/** True when `cls` is a polymorphic registry base (the deliberate no-discriminator fallback class). */
const isRegistryBase = (cls: string): boolean => !!schema.registries[cls];

type Finding = { file: string; line: number; group: string; cause: string; detail?: string };
interface AuditResult {
    files: number;
    groupsTotal: number;
    groupsResolved: number;
    counts: Record<string, number>;
    findings: Finding[];
}

/**
 * Builds the production index stack over the given folders and classifies every group in every
 * `.rules` file (language strings folders excluded, they are deliberately schema-free).
 *
 * @param modDirs the mod folders to include beside the game data.
 * @returns the classified counts and dark-group findings.
 */
const runAudit = async (modDirs: string[]): Promise<AuditResult> => {
    const parseReal = (p: string) => parser(lexer(readFileSync(p, 'utf8')), pathToFileURL(p).href).value;
    const resolveRef = async (fileRef: string, fromUri: string) => {
        const m = /<([^>]*)>/.exec(fileRef);
        if (!m) return undefined;
        const rel = m[1].trim();
        if (!rel) return undefined;
        const withExt = /\.[^/.]+$/.test(rel) ? rel : `${rel}.rules`;
        for (const abs of [join(dirname(fileURLToPath(fromUri)), withExt), join(DATA_DIR, withExt), join(dirname(DATA_DIR), withExt)]) {
            if (existsSync(abs)) { try { return parseReal(abs); } catch { return undefined; } }
        }
        return undefined;
    };
    globalSettings.cosmoteerPath = DATA_DIR;
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const svc = CosmoteerWorkspaceService.instance;
    svc.setConnection({ languages: { diagnostics: { refresh: () => undefined } }, window: { showWarningMessage: () => undefined } } as unknown as Connection);
    await svc.initialize(DATA_DIR, noop);
    aliasRootIndex.invalidate();
    await aliasRootIndex.build(parseReal(join(DATA_DIR, 'cosmoteer.rules')), resolveRef);

    clearModRootCache();
    invalidateModContext();
    MemberInjectionIndex.instance.reset();
    AddBaseIndex.instance.reset();
    ReverseIncludeIndex.instance.reset();
    if (modDirs.length > 0) {
        await MemberInjectionIndex.instance.ensureBuilt([DATA_DIR, ...modDirs], token);
        await AddBaseIndex.instance.ensureBuilt([DATA_DIR, ...modDirs], token);
    }
    await ReverseIncludeIndex.instance.ensureBuilt([DATA_DIR, ...modDirs], token);

    const files = [...rulesFiles(DATA_DIR), ...modDirs.flatMap((d) => rulesFiles(d))];
    const findings: Finding[] = [];
    const counts: Record<string, number> = {};
    let groupsTotal = 0;
    let groupsResolved = 0;
    const bump = (cause: string) => (counts[cause] = (counts[cause] ?? 0) + 1);

    const auditGroup = (group: GroupNode, file: string): void => {
        groupsTotal++;
        const cls = resolveGroupClass(group);
        // Shader-constant names (`_hotColor`) come from the referenced .shader, never the schema, so
        // they don't count against a class fit, and a group WRITTEN under such a name belongs to the
        // shader-constant machinery, not the schema. Macro members (`SCREAMING_SNAKE` anchors like
        // `HEAT_PER_SHOT` or `T_1`) are the modder's own find/replace scaffolding, equally schema-free.
        const isMacroName = (n: string) => /^[A-Z][A-Z0-9_]*$/.test(n) && n !== n.toLowerCase();
        const names = namedMemberNames(group).filter((n) => !n.startsWith('_') && !isMacroName(n));
        const name = group.identifier?.name ?? '(anonymous)';
        const line = group.position?.line ?? 0;
        if (name.startsWith('_')) {
            groupsResolved++;
            bump('ok-shader-constant');
            return;
        }
        // A macro anchor group (`OVERCLOCK { HEAT_PER_SHOT = 90 … }`, `BASE { … }`) is deliberate
        // scaffolding for `&~/OVERCLOCK/…` references, never a schema class.
        if (isMacroName(name)) {
            groupsResolved++;
            bump('ok-macro-anchor');
            return;
        }
        if (cls) {
            groupsResolved++;
            // A polymorphic slot with no usable discriminator resolves to the registry base as a
            // deliberate keep-the-base-fields-working fallback, which never fits fully.
            if (isRegistryBase(cls)) {
                bump('ok-registry-base-fallback');
                return;
            }
            // Particle updater/def groups mix schema fields with file-local channel bindings and
            // pre-initializers, which the particle-channel machinery owns, so their fit is not
            // judged here.
            if (/Particle/.test(cls)) {
                bump('ok-particle-class');
                return;
            }
            // Fit check: a resolved class that owns under half of the group's own field names is a
            // mis-typing signal (the `Type = Beam` media-effect case, the deep-member deriver case).
            if (names.length >= 3) {
                const known = names.filter((n) => fieldOf(cls, n)).length;
                if (known / names.length < 0.5) {
                    bump('bad-fit');
                    findings.push({ file, line, group: name, cause: 'bad-fit', detail: `${cls} owns ${known}/${names.length}` });
                    return;
                }
            }
            bump('ok-resolved');
            return;
        }
        // A class-less container whose child groups resolve anyway (a part's custom-read
        // `Components` map, typed per child through sibling registry inference) works in practice.
        if (group.elements.some((e) => isGroupNode(e) && !!resolveGroupClass(e))) {
            groupsResolved++;
            bump('ok-container-of-resolved');
            return;
        }
        const disc = groupDiscriminator(group);
        if (disc) {
            if (classByDiscriminator(disc)) {
                bump('disc-known-but-unresolved');
                findings.push({ file, line, group: name, cause: 'disc-known-but-unresolved', detail: disc });
            } else {
                bump('unknown-disc');
                findings.push({ file, line, group: name, cause: 'unknown-disc', detail: disc });
            }
            return;
        }
        // A group whose class comes through its inheritance (`MyTurret : BaseTurret { }`) resolves
        // on the async inheritance path the real features use; the sync walk here cannot see it.
        if (group.inheritance?.length) {
            groupsResolved++;
            bump('ok-inherits-class');
            return;
        }
        const container = group.parent;
        const slot =
            container && isListNode(container)
                ? listSlotType(container)
                : container && (isGroupNode(container) || isDocumentNode(container)) && group.identifier
                  ? memberTypeIn(container, group.identifier.name)
                  : undefined;
        if (slot) {
            // A range slot's `{ Value | Min/Max }` form and a map-typed group are class-less by
            // design; their members type through the slot, so they are not dark. An opaque slot is
            // deliberately permissive (runtime-polymorphic engine types).
            if (slot.kind === 'range' && names.some((n) => /^(value|min|max)$/i.test(n))) {
                groupsResolved++;
                bump('ok-range-keys-form');
                return;
            }
            if (slot.kind === 'map') {
                groupsResolved++;
                bump('ok-map-form');
                return;
            }
            if (slot.kind === 'opaque') {
                groupsResolved++;
                bump('ok-opaque-slot');
                return;
            }
            bump('slot-typed-but-unresolved');
            findings.push({ file, line, group: name, cause: 'slot-typed-but-unresolved', detail: slot.kind });
            return;
        }
        if (container && isDocumentNode(container)) {
            const root = documentRootClass(container);
            if (root) {
                bump('root-class-misses-member');
                findings.push({ file, line, group: name, cause: 'root-class-misses-member', detail: root });
            } else {
                bump('unrooted-top-group');
                findings.push({ file, line, group: name, cause: 'unrooted-top-group' });
            }
            return;
        }
        bump('nested-untyped');
        findings.push({ file, line, group: name, cause: 'nested-untyped' });
    };

    const visit = (node: AbstractNode, file: string): void => {
        if (isGroupNode(node)) auditGroup(node, file);
        const kids: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const kid of kids) visit(kid, file);
    };

    try {
        for (const file of files) {
            // Language strings files are localization text, deliberately schema-free.
            if (/[/\\]strings[/\\]/i.test(file)) continue;
            let doc: AbstractNodeDocument;
            try { doc = parseReal(file); } catch { continue; }
            visit(doc, file.replace(/\\/g, '/'));
        }
    } finally {
        ReverseIncludeIndex.instance.reset();
        MemberInjectionIndex.instance.reset();
        AddBaseIndex.instance.reset();
        aliasRootIndex.invalidate();
        clearModRootCache();
        invalidateModContext();
    }
    return { files: files.length, groupsTotal, groupsResolved, counts, findings };
};

describe.skipIf(!HAVE_DATA)('vanilla dark-group gate', () => {
    // Ceilings pinned 2026-07-12 (after the range-group-form, deep-member-deriver and super-path
    // fixes). A rise in any dark cause, or a drop in the resolved fraction, means a resolution
    // regression: something that used to have hover/completion went dark, or resolves to a class
    // that does not fit. Improvements are welcome; re-pin the numbers downward when they land.
    it('keeps every dark cause at or below its pinned ceiling', async () => {
        const result = await runAudit([]);
        // An optional dump of the vanilla-only findings for triage (the mods dump below shows
        // vanilla files under mod-influenced indexes, which can differ).
        if (process.env.AUDIT_VANILLA_OUT) writeFileSync(process.env.AUDIT_VANILLA_OUT, JSON.stringify(result, null, 1));
        const fraction = result.groupsResolved / result.groupsTotal;
        console.log('vanilla groups', result.groupsTotal, 'resolved', (100 * fraction).toFixed(2) + '%', result.counts);
        expect(fraction).toBeGreaterThan(0.985);
        expect(result.counts['bad-fit'] ?? 0).toBeLessThanOrEqual(4);
        expect(result.counts['unknown-disc'] ?? 0).toBeLessThanOrEqual(2);
        expect(result.counts['disc-known-but-unresolved'] ?? 0).toBeLessThanOrEqual(5);
        expect(result.counts['root-class-misses-member'] ?? 0).toBeLessThanOrEqual(3);
        expect(result.counts['slot-typed-but-unresolved'] ?? 0).toBeLessThanOrEqual(10);
        expect(result.counts['unrooted-top-group'] ?? 0).toBeLessThanOrEqual(45);
        expect(result.counts['nested-untyped'] ?? 0).toBeLessThanOrEqual(430);
    }, 600_000);
});

describe.skipIf(!HAVE_MODS)('dark-group audit over vanilla + workshop mods', () => {
    it('classifies every unresolved or badly-fitting group', async () => {
        const modDirs = readdirSync(MODS_DIR)
            .map((d) => join(MODS_DIR, d))
            .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
        const result = await runAudit(modDirs);
        writeFileSync(OUT, JSON.stringify(result, null, 1));
        console.log('files', result.files, 'groups', result.groupsTotal, 'resolved', result.groupsResolved, JSON.stringify(result.counts));
        expect(result.groupsTotal).toBeGreaterThan(0);
    }, 1_200_000);
});
