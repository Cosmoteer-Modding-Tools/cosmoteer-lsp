import { relativeRulesReference } from '../shared-base/base-file.emitter';

/**
 * Emits the `Overrides` entry a mod writes to change one value the game install owns, in the shape
 * the game's own `Standard Mods/example_mod/mod.rules` teaches it: an `OverrideIn` naming the group
 * against the game root and an `Overrides { … }` map of the members to change.
 *
 * Exactly one member is ever written. The game replaces a whole child per entry rather than merging
 * into it, so a nested body would delete everything else under the node it nests through.
 */

/** Where the `Overrides` map comes from: written into the action, or read from a file of the mod. */
export type OverridesSource =
    | {
          /** The map is written into the manifest, which suits a value or two. */
          readonly kind: 'inline';
          /** The member's source, already indented for its place inside the action entry. */
          readonly body: string;
      }
    | {
          /** The map is a group of a file of the mod, which keeps a long body out of the manifest. */
          readonly kind: 'reference';
          /** The reference to that group, sigil included, resolved against the manifest's directory. */
          readonly reference: string;
      };

/**
 * The game-root path of the group an override targets, the form an action target takes: read from
 * the game's own `Data` root rather than from the manifest, so it is expressed relative to that root.
 *
 * An empty path names the file itself, which `Overrides` accepts because a file's top level is a
 * group in the game's own tree (`OTFile` derives from `OTGroupNode`).
 *
 * @param dataRoot the game's `Data` directory.
 * @param fsPath the overridden file's on-disk path.
 * @param memberPath the member names from that file's root down to the group, outermost first.
 * @returns the target path, with forward slashes on every platform.
 */
export const overridesTargetPath = (dataRoot: string, fsPath: string, memberPath: readonly string[]): string =>
    relativeRulesReference(dataRoot, fsPath, memberPath.length > 0 ? memberPath.join('/') : undefined);

/**
 * One `Overrides` action entry, changing a single member of a single group.
 *
 * `CreateIfNotExisting` and `IgnoreIfNotExisting` are left out: both default to false, which is what
 * this action wants, and a target the game no longer has is a mistake worth an error rather than a
 * silent no-op.
 *
 * @param target the game-root path of the group being overridden.
 * @param source the map to apply, written in place or read from a file of the mod.
 * @param indent the indentation the entry's own lines carry.
 * @param lineEnding the ending the manifest already uses, so the entry matches it.
 * @returns the entry's text, with no trailing line ending.
 */
export const overridesActionText = (
    target: string,
    source: OverridesSource,
    indent: string,
    lineEnding: '\n' | '\r\n' = '\n'
): string => {
    const head = [`${indent}{`, `${indent}\tAction = Overrides`, `${indent}\tOverrideIn = "${target}"`];
    const map =
        source.kind === 'reference'
            ? [`${indent}\tOverrides = ${source.reference}`]
            : [`${indent}\tOverrides`, `${indent}\t{`, ...bodyLines(source.body, indent), `${indent}\t}`];
    return [...head, ...map, `${indent}}`].join(lineEnding);
};

/**
 * The body's own lines, re-prefixed so an entry written at a deeper indentation keeps its shape.
 *
 * The body arrives indented for an entry sitting one tab in, which is where a manifest's own
 * `Actions` list puts it, so anything deeper has the difference added in front of every line.
 *
 * @param body the member's source, indented for the default depth.
 * @param indent the indentation the entry's own lines carry.
 * @returns the body's lines, blank lines left blank.
 */
const bodyLines = (body: string, indent: string): string[] => {
    const extra = indent.length > 1 ? indent.slice(1) : '';
    return body.split('\n').map((line) => (line.length === 0 ? line : extra + line));
};

/**
 * The full text of the fragment file the file-shaped variant creates: one group holding the member,
 * which the action then points its `Overrides` at.
 *
 * @param groupName the name of the group inside the file.
 * @param body the member's source, indented for its place inside an action entry.
 * @param lineEnding the ending to write, so a file added to a mod written with `\r\n` does not
 * arrive with a different one than every file around it.
 * @returns the file's contents, newline terminated.
 */
export const sparseOverrideFileText = (
    groupName: string,
    body: string,
    lineEnding: '\n' | '\r\n' = '\n'
): string => {
    // The body is indented for an action entry, which sits three tabs in. A file of its own starts
    // one tab in, so the surplus comes off every line.
    const lines = body.split('\n').map((line) => (line.startsWith('\t\t') ? line.slice(2) : line));
    return [groupName, '{', ...lines, '}', ''].join('\n').split('\n').join(lineEnding);
};
