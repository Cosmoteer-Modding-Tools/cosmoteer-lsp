/**
 * Fields the game reads and then gets wrong.
 *
 * The schema says a class declares a field and what shape its value has, and the dead-field check
 * says when nothing reads it at all. Neither can say that the reader takes the value and puts it
 * somewhere else, or that a method is handed a flag and never looks at it. A field like that is the
 * worst kind to author against: it validates, it loads, and the game does something other than what
 * it says.
 *
 * Every entry is read out of the shipped assembly, from the line that mishandles the value. Rows
 * are keyed by the exact class, never by its derivations, because the sibling classes these sit
 * beside read the same field correctly and flagging them would be wrong.
 */

/** What makes the field wrong where it is written. */
export type MishandledCondition =
    /** Writing the field at all is the defect, whatever its value. */
    | { readonly kind: 'written' }
    /** The field carries one particular value the reader mishandles. */
    | { readonly kind: 'valueEquals'; readonly value: string };

/** Which message the field gets, since what the game does with it differs per row. */
export type MishandledEffect =
    /** The reader appends the value to the include list, so it selects rather than excludes. */
    | 'excludeIdInverts'
    /** The generator takes the flag and never reads it, so it still throws on a missing sprite. */
    | 'toggledBlendFlagIgnored'
    /** The damping formula collapses, taking the sibling coefficient out of the result with it. */
    | 'dragExponentOne';

/** One field one class mishandles. */
export interface MishandledFieldRule {
    /** The class that owns the read, matched exactly. */
    readonly owner: string;
    readonly field: string;
    readonly condition: MishandledCondition;
    readonly severity: 'warning' | 'hint';
    readonly effect: MishandledEffect;
}

export const MISHANDLED_FIELD_RULES: readonly MishandledFieldRule[] = [
    // The singular shorthands each fold into their plural list, and this one folds into the wrong
    // one: `ExcludeID` is appended to `IDs`. Since the matcher rejects a part that is not in `IDs`
    // once that list exists, naming a part to exclude makes it the only part accepted. The sibling
    // `ExcludeCategory` block two lines below appends to `ExcludeCategories` correctly.
    {
        owner: 'Cosmoteer.Ships.Parts.RelativePartCriteria',
        field: 'ExcludeID',
        condition: { kind: 'written' },
        severity: 'warning',
        effect: 'excludeIdInverts',
    },
    // The toggled generator takes an `allowUndefinedBlendSprites` parameter and its body never
    // mentions it, so it throws on an uncovered combination either way. The plain blend sprite
    // classes honour the same flag, which is why this is keyed by the exact class.
    {
        owner: 'Cosmoteer.Ships.Parts.Graphics.PartToggledBlendSpritesRules',
        field: 'AllowUndefinedBlendSprites',
        condition: { kind: 'written' },
        severity: 'hint',
        effect: 'toggledBlendFlagIgnored',
    },
    {
        owner: 'Cosmoteer.Ships.Blueprints.Graphics.BlueprintPartToggledBlendSpritesRules',
        field: 'AllowUndefinedBlendSprites',
        condition: { kind: 'written' },
        severity: 'hint',
        effect: 'toggledBlendFlagIgnored',
    },
    // The exponential damping formula divides by `1 - exponent`, so an exponent of one leaves the
    // whole expression at one and the damping at `1 / speed`. The coefficient is multiplied by
    // `timeStep - exponent * timeStep`, which is zero at the same time, so it decides nothing.
    {
        owner: 'Halfling.Physics2D.Dynamics.Drag.ExponentialLinearDragSolver/ExponentialLinearDragSolverRules',
        field: 'Exponent',
        condition: { kind: 'valueEquals', value: '1' },
        severity: 'warning',
        effect: 'dragExponentOne',
    },
    {
        owner: 'Halfling.Physics2D.Dynamics.Drag.ExponentialAngularDragSolver/ExponentialAngularDragSolverRules',
        field: 'Exponent',
        condition: { kind: 'valueEquals', value: '1' },
        severity: 'warning',
        effect: 'dragExponentOne',
    },
];
