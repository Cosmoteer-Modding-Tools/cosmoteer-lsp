import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { aliasRootIndex } from '../../document/schema/alias-root';
import { findModRoot } from '../../mod/mod-root';
import { ActionRootingIndex } from '../../mod/action-rooting.index';
import { MemberInjectionIndex } from '../../mod/member-injection.index';
import { modOverrideMemberNamesForFile } from '../../mod/mod-context';
import { namedMembersOf } from '../../utils/ast.utils';
import { cachedParseFilePath } from '../../workspace/fs-cache';
import { SchemaIdIndex } from '../completion/schema-id.index';
import { uriToFsPath } from '../navigation/workspace-files';

/**
 * The image names a `<img name='…'/>` in a drawn string can carry.
 *
 * `TextAssetLibrary` is filled from the data rather than hard-coded, so the whole set is knowable
 * from the project. Three things register one:
 *
 *  - every key of the game root's `TextSprites` map, which is `gui/text_sprites.rules` plus whatever
 *    a mod merges into it, whether by wiring a table of its own or by an `Overrides` action naming
 *    the game's file,
 *  - `resource.<id>` for a resource that declares an `Icon`,
 *  - `faction_<id>` for every faction.
 *
 * A name nothing registers makes `TryGetImage` fail, which throws and takes the markup of the whole
 * string with it, so the set is worth knowing exactly. Resources are taken without asking whether
 * they declare an icon: a resource can inherit one from its base, and a name we wrongly accept costs
 * nothing while one we wrongly reject is a false positive.
 */
const TEXT_SPRITE_CLASS = 'Cosmoteer.Data.TextSprite';
const RESOURCE_CLASS = 'Cosmoteer.Resources.ResourceRules';
const FACTION_CLASS = 'Cosmoteer.Factions.FactionRules';

/** The last answer, keyed by the folders and the revisions of the indexes it was read from. */
let memo: { key: string; names: Set<string> } | undefined;

/**
 * The top-level member names of one text-sprite table, the members a mod merges into it included.
 *
 * @param uri the table's document uri.
 * @param originUri a file of the mod being edited, which locates the mod whose merges count.
 * @param cancellationToken cancels the read.
 * @returns the names the table declares, empty when it cannot be read.
 */
const namesOfTable = async (
    uri: string,
    originUri: string | undefined,
    cancellationToken: CancellationToken
): Promise<string[]> => {
    let document: AbstractNodeDocument;
    try {
        document = await cachedParseFilePath(uriToFsPath(uri), cancellationToken);
    } catch {
        return [];
    }
    const names = [...namedMembersOf(document)].map(([name]) => name);
    names.push(...MemberInjectionIndex.instance.injectedMemberNames(document));
    // A whole-file `Overrides` (`OverrideIn = "<gui/text_sprites.rules>"`) is the shape a mod adds
    // its own icons with, and the mod context is what models one.
    if (originUri) {
        names.push(...(await modOverrideMemberNamesForFile(document, originUri).catch(() => [])));
    }
    return names;
};

/**
 * Every image name the project registers, which is what an `<img name='…'/>` may carry.
 *
 * @param folderPaths the project folders the id index is built from.
 * @param cancellationToken cancels the index builds and the table reads.
 * @param originUri a file of the mod being edited, which locates the mod whose merges count.
 * @returns the registered names, empty when the game tree is not indexed yet.
 */
export const textImageNames = async (
    folderPaths: string[],
    cancellationToken: CancellationToken,
    originUri?: string
): Promise<Set<string>> => {
    const tables = [
        ...aliasRootIndex.urisRootedAsMapOf(TEXT_SPRITE_CLASS),
        ...ActionRootingIndex.instance.urisRootedAsMapOf(TEXT_SPRITE_CLASS),
    ];
    const key = [
        folderPaths.join('|'),
        findModRoot(originUri ?? '') ?? '',
        aliasRootIndex.revision,
        ActionRootingIndex.instance.revision,
        MemberInjectionIndex.instance.revision,
        SchemaIdIndex.instance.revision,
        tables.length,
    ].join('#');
    if (memo?.key === key) return memo.names;

    const names = new Set<string>();
    for (const uri of tables) {
        for (const name of await namesOfTable(uri, originUri, cancellationToken)) names.add(name);
    }
    for (const id of await SchemaIdIndex.instance.primaryIdsForClass(RESOURCE_CLASS, folderPaths, cancellationToken)) {
        names.add('resource.' + id);
    }
    for (const id of await SchemaIdIndex.instance.primaryIdsForClass(FACTION_CLASS, folderPaths, cancellationToken)) {
        names.add('faction_' + id);
    }
    memo = { key, names };
    return names;
};

/** Forget the memoized answer, for a test that rebuilds the indexes under it. */
export const resetTextImageNames = (): void => {
    memo = undefined;
};
