import { CompletionItemKind } from 'vscode-languageserver';
import { Completion } from './autocompletion.service.types';

/**
 * Idioms: the small settings a modder has to be told about, offered where they apply.
 *
 * A schema field completes on its own, because the field list comes out of the game's own classes.
 * What the schema cannot say is that one particular value of one particular field is a technique,
 * with a reason and a catch. `AIValueFactor = 0` is the shape: the field is documented, the value is
 * just a number, and the fact that writing that number is how the game's own armour drops out of the
 * enemy's target scoring lives nowhere except in the heads of people who have read the vanilla data.
 *
 * Each entry is offered beside the field names of the class it belongs to, at a field-name position,
 * and only while the field is not already written. Accepting one writes the whole assignment, so the
 * technique arrives complete rather than as a name the author then has to guess a value for.
 *
 * Adding one is a table entry and nothing else. The bar for adding it: the value has to be a real
 * technique rather than a default worth restating, its effect has to be readable in the game's own
 * code, and the entry has to say what the value does NOT do wherever that is the part people get
 * wrong.
 */
export interface Idiom {
    /** The schema class whose members this is offered beside. */
    readonly owner: string;
    /** The member the idiom writes, used to withhold it once the file already writes that member. */
    readonly field: string;
    /** The whole assignment, written as the author would write it. */
    readonly insertText: string;
    /** The one line the popup shows beside the label. */
    readonly detail: string;
    /** The markdown the popup expands to, saying what it does and what it does not do. */
    readonly documentation: string;
}

/** Every idiom, keyed by nothing: the list is short and read start to finish. */
export const IDIOMS: readonly Idiom[] = [
    {
        owner: 'Cosmoteer.Ships.Parts.PartRules',
        field: 'AIValueFactor',
        insertText: 'AIValueFactor = 0',
        detail: 'the AI stops picking this part as a target',
        documentation: [
            'The AI scores a target part by `AIValueFactor` times `Cost`, and only ever scores a part',
            'whose factor is above zero. Writing zero is how the shipped armour parts keep the enemy',
            'aiming at something behind them.',
            '',
            'It does not make the part untargetable. A ship the AI finds no positive part on has one of',
            'its remaining parts picked at random, so zero means the part is never chosen on purpose',
            'rather than never shot at.',
        ].join('\n'),
    },
];

/**
 * The idioms offered for a group, minus the ones whose field the group already writes.
 *
 * @param classes the classes the group resolved to, primary first.
 * @param present the member names the group already writes, lower-cased.
 * @returns one completion per idiom that still applies.
 */
export const idiomCompletions = (classes: readonly string[], present: ReadonlySet<string>): Completion[] =>
    IDIOMS.filter((idiom) => classes.includes(idiom.owner) && !present.has(idiom.field.toLowerCase())).map((idiom) => ({
        label: idiom.insertText,
        kind: CompletionItemKind.Snippet,
        detail: idiom.detail,
        documentation: idiom.documentation,
        insertText: idiom.insertText,
        // The popup filters on what the author has typed, and they reach for the field name rather
        // than the whole assignment, so the field name is what the typed letters are matched against.
        filterText: idiom.field,
        // Below the field the idiom writes, which stays the way to reach any other value of it.
        sortText: `1_zz_${idiom.field}`,
    }));
