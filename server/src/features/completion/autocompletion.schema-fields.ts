import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { findEnclosingGroup, registryForGroup, resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass, documentRootRegistry } from '../../document/schema/document-root';
import {
    enumDef,
    fieldOf,
    fieldSignatureMarkdown,
    fieldsOf,
    isLocalizationKeyType,
    valueTypeLabel,
} from '../../document/schema/schema';
import { SchemaRegistry, ValueType } from '../../document/schema/schema.types';
import { Completion } from './autocompletion.service';
import { completeFieldValue, discriminatorCompletions } from './autocompletion.schema';
import { resolveClassThroughInheritance } from './inheritance-resolution';
import { shaderConstantCompletions, shaderConstantGroupClass } from './autocompletion.shader-constants';

/**
 * The snippet inserted when a field name is accepted, it scaffolds the field's structure so the user
 * lands ready to type the value: `Name = $0` for a scalar, a `{ … }` block for a group (with `Type = `
 * primed for a polymorphic one), `[ … ]` for a list. `$0` is the final cursor stop. Subsequent lines'
 * indentation is normalized to the insertion point by `InsertTextMode.adjustIndentation`.
 */
const fieldSnippet = (name: string, valueType: ValueType, stop = '$0'): string => {
    switch (valueType.kind) {
        case 'group':
        case 'map':
            return `${name}\n{\n\t${stop}\n}`;
        case 'polymorphicGroup':
            return `${name}\n{\n\tType = ${stop}\n}`;
        case 'list':
            return `${name}\n[\n\t${stop}\n]`;
        case 'range':
        case 'tuple':
            return `${name} = [${stop}]`;
        default:
            return `${name} = ${stop}`;
    }
};

/**
 * Field-name completion: at an empty insertion point whose schema class is known, offer that class's
 * not-yet-present fields. The scope is the enclosing group, or at a whole-file-root document's top
 * level the document's root class (e.g. a shot file → `BulletRules`). Offset-based (like the
 * mod.rules path) because an empty line has no AST leaf under the cursor. Required fields sort first.
 */
export const schemaFieldNameCompletions = async (
    document: AbstractNodeDocument,
    offset: number,
    cancellationToken: CancellationToken
): Promise<Completion[]> => {
    const group = findEnclosingGroup(document, offset);
    // Inheritance-aware: a `MyTurret : ^/0/Turret { … }` group inherits its class from the base.
    let cls = group ? await resolveClassThroughInheritance(group, cancellationToken) : documentRootClass(document);
    // A shader constant written in group form (`_waveTex { … }`) is not a schema field, so the slot
    // walk cannot type it. Resolve its class from the material's referenced `.shader` file instead.
    if (!cls && group) cls = await shaderConstantGroupClass(group, document.uri, cancellationToken);
    // Lower-cased: an already-written `maxhealth` counts as `MaxHealth` (game lookup ignores case).
    const present = new Set(namedMembersOf(group ?? document).map(([name]) => name.toLowerCase()));
    const missing = cls ? fieldsOf(cls).filter((field) => !present.has(field.name.toLowerCase())) : [];
    const completions: Completion[] = missing.map((field) => ({
        label: field.name,
        kind: CompletionItemKind.Field,
        detail: `${valueTypeLabel(field.valueType)}${field.optional ? '' : ' · required'}`,
        documentation: fieldSignatureMarkdown(field, cls ?? undefined),
        insertText: fieldSnippet(field.name, field.valueType),
        isSnippet: true,
        // Required fields sort above optional ones (LSP sorts by sortText lexicographically).
        sortText: `${field.optional ? '1' : '0'}_${field.name}`,
    }));

    // One pick that scaffolds all the still-missing required fields at once (each a numbered tab stop).
    const requiredMissing = missing.filter((field) => !field.optional);
    if (requiredMissing.length >= 2) {
        completions.unshift({
            label: `Insert ${requiredMissing.length} required fields`,
            kind: CompletionItemKind.Snippet,
            detail: requiredMissing.map((f) => f.name).join(', '),
            documentation: `Scaffolds the required fields: ${requiredMissing.map((f) => `\`${f.name}\``).join(', ')}`,
            insertText: requiredMissing.map((f, i) => fieldSnippet(f.name, f.valueType, `$${i + 1}`)).join('\n'),
            isSnippet: true,
            sortText: '00', // after the injected `Type` ('0'), before individual fields ('0_…')
        });
    }

    // A polymorphic group that hasn't chosen its concrete subtype yet has no class-specific fields to
    // offer beyond the base — but it must declare `Type` to dispatch. `Type` is not a schema field
    // (the serializer handles it), so inject it explicitly, sorted to the very top.
    if (group) {
        const registry = registryForGroup(group);
        if (registry && !present.has(registry.typeField.toLowerCase())) {
            completions.unshift(discriminatorFieldCompletion(registry));
        }
        // A material group additionally offers its shader's `_`-prefixed uniforms, read from the
        // `.shader` file its `Shader` field points at (not from the schema).
        completions.push(...(await shaderConstantCompletions(group, document.uri, present, cancellationToken)));
    }
    return completions;
};

/** Matches an in-progress value assignment at the end of a line: `Key = ` (value still empty). */
const VALUE_POSITION = /(?:^|[\s{;[])([A-Za-z_]\w*)\s*=\s*$/;

/** The field being assigned at an empty `Key = ` insertion point, or undefined if not one. */
const fieldNameAtValuePosition = (linePrefix: string): string | undefined => VALUE_POSITION.exec(linePrefix)?.[1];

/**
 * Value completion at an empty `Key = ` insertion point, where the AST has no value leaf yet, so the
 * value-node completer can't fire. Detects the field being assigned from the line text and offers the
 * same legal values (enum members, `true`/`false`, `Type=` discriminators, sibling component ids) the
 * value-node path would. Returns `undefined` when not at a value position (so the caller falls back to
 * field-name completion). At a value position it returns the values (possibly empty, the caller must
 * not then offer field names, since `Key = X` always wants a value).
 */
export const schemaValueCompletionsAtOffset = (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string
): Completion[] | undefined => {
    const fieldName = fieldNameAtValuePosition(linePrefix);
    if (!fieldName) return undefined;

    const group = findEnclosingGroup(document, offset);
    if (group) return completeFieldValue(group, fieldName, resolveGroupClass(group));

    // Document top level (whole-file root): `Type` → root registry discriminators, else enum/bool field.
    const registry = documentRootRegistry(document);
    if (registry && fieldName === registry.typeField) return discriminatorCompletions(registry);
    const field = fieldAtOffset(document, offset, fieldName);
    if (field?.valueType.kind === 'enum') {
        return (enumDef(field.valueType.ref)?.members ?? []).map((member) => ({
            label: member,
            kind: CompletionItemKind.EnumMember,
            detail: field.valueType.kind === 'enum' ? field.valueType.name : undefined,
        }));
    }
    if (field?.valueType.kind === 'bool') {
        return [
            { label: 'true', kind: CompletionItemKind.Value },
            { label: 'false', kind: CompletionItemKind.Value },
        ];
    }
    return [];
};

/** The schema field of the `Key = ` being assigned at `offset` (group member or whole-file root). */
const fieldAtOffset = (document: AbstractNodeDocument, offset: number, fieldName: string) => {
    const group = findEnclosingGroup(document, offset);
    const cls = group ? resolveGroupClass(group) : documentRootClass(document);
    return cls ? fieldOf(cls, fieldName) : undefined;
};

/**
 * Finds the class a cross-file `ID<X>` reference field targets at a value position, for routing to
 * the cross-file id index when the sync value completer has nothing (`ResourceType = ` → `ResourceRules`,
 * `TypeCategories = [ … ]` → `PartCategory`). A direct reference field gives its target, and a
 * `list<reference>` field gives its element target so a list element position completes too.
 *
 * @param document the parsed document the cursor is in.
 * @param offset the cursor byte offset.
 * @param linePrefix the text from the line start to the cursor, used to read the field name.
 * @returns the target class FullName, or undefined when the position is not a reference field value.
 */
export const crossFileReferenceTargetAtOffset = (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string
): string | undefined => {
    const fieldName = fieldNameAtValuePosition(linePrefix);
    if (!fieldName) return undefined;
    const valueType = fieldAtOffset(document, offset, fieldName)?.valueType;
    if (valueType?.kind === 'reference') return valueType.target;
    if (
        (valueType?.kind === 'list' || valueType?.kind === 'range' || valueType?.kind === 'interpolated') &&
        valueType.element.kind === 'reference'
    ) {
        return valueType.element.target;
    }
    return undefined;
};

/**
 * Whether the empty `Key = ` value position at `offset` is a localization-key field (C# `KeyString`),
 * so the caller can offer the project's strings keys. Mirrors {@link crossFileReferenceTargetAtOffset}
 * for the offset-based path where the AST has no value leaf yet.
 *
 * @param document the parsed document the cursor is in.
 * @param offset the cursor byte offset.
 * @param linePrefix the text from the line start to the cursor, used to read the field name.
 * @returns true when the position is a localization-key field value.
 */
export const isLocalizationKeyFieldAtOffset = (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string
): boolean => {
    const fieldName = fieldNameAtValuePosition(linePrefix);
    if (!fieldName) return false;
    return isLocalizationKeyType(fieldAtOffset(document, offset, fieldName)?.valueType);
};

/** The `Type = …` field-name completion for a polymorphic group, documenting its discriminator set. */
const discriminatorFieldCompletion = (registry: SchemaRegistry): Completion => {
    const members = Object.keys(registry.members);
    const shown = members.slice(0, 20).map((m) => `\`${m}\``).join(', ');
    return {
        label: registry.typeField,
        kind: CompletionItemKind.Field,
        detail: `${registry.name} type · required`,
        documentation: `**${registry.typeField}**: the \`${registry.name}\` subtype — one of: ${shown}${
            members.length > 20 ? `, … (${members.length} total)` : ''
        }`,
        insertText: `${registry.typeField} = $0`,
        isSnippet: true,
        sortText: '0', // before every other field (which sort as `0_…`/`1_…`)
    };
};
