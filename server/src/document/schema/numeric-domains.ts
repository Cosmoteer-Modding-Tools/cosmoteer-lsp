/**
 * Numbers a field's consumer refuses, and the relations between two fields that decide it.
 *
 * The schema carries no numeric domain: it types a field `int` or `ModifiableTime` and says
 * nothing about which values the code reading it can survive. Most of those are already covered by
 * the generic division check, which reads the expression in the file. These are the ones it cannot
 * see, where the number is fine as written and the engine divides by it, sizes a buffer from it, or
 * loops on it at runtime.
 *
 * Every entry is read out of the shipped assembly, from the call the value reaches, and is keyed by
 * the exact class. That matters: `FromQuantity` and `ToQuantity` also exist on the ordinary
 * resource converter, where they are modifiable and are never divided by.
 */

/** What the consumer does with a number outside the domain. */
export type NumericDomainEffect =
    /** The read throws where the value is used, which is not where the file is loaded. */
    | 'throws'
    /** The read loops without advancing, so the process stops responding altogether. */
    | 'hangs'
    /** The value is read and acted on, and what comes out is wrong rather than fatal. */
    | 'wrong';

/** One field whose consumer refuses part of the range the schema allows. */
export interface NumericDomainRule {
    /** The class that owns the read, matched exactly. */
    readonly owner: string;
    readonly field: string;
    /** The smallest value the consumer survives, inclusive. */
    readonly atLeast: number;
    /**
     * A sibling that switches the rule on. Without it the field is unread, so a value outside the
     * domain is harmless, and the absent field takes `whenAbsent` as its value.
     */
    readonly onlyWhenSiblingAbove?: { readonly field: string; readonly value: number };
    /** The value the game reads when the field is not written at all, when that is itself unsafe. */
    readonly whenAbsent?: number;
    readonly effect: NumericDomainEffect;
}

export const NUMERIC_DOMAIN_RULES: readonly NumericDomainRule[] = [
    // `BeamEmitter.DoEmitBeam` accumulates `HitInterval` in a `while (_damageTimeRemaining <= 0f)`
    // whose counter starts at zero, so a zero interval never advances it and the loop fires its hit
    // effects forever. The sibling loop in `Weapon.cs` carries the `> 0` guard this one lacks. Only
    // the continuous branch reaches it: `Emit` forks on `Duration`, and the instant path never
    // reads the interval. Both fields are optional with a zero initialiser, so the hazard is an
    // omission rather than a written zero.
    {
        owner: 'Cosmoteer.Ships.Parts.Weapons.BeamEmitterRules',
        field: 'HitInterval',
        atLeast: Number.MIN_VALUE,
        onlyWhenSiblingAbove: { field: 'Duration', value: 0 },
        whenAbsent: 0,
        effect: 'hangs',
    },
    // `InlineResourceConverter` divides by both of these in four getters and three writers, all of
    // them reached while the part is being built. `ToQuantity` detonates a second time when a save
    // is read, where `Mathx.Clamp(overflow, 0, ToQuantity - 1)` is handed a maximum below its
    // minimum. Both are plain integers here, so no buff can move them.
    {
        owner: 'Cosmoteer.Ships.Parts.Resources.InlineResourceConverterRules',
        field: 'FromQuantity',
        atLeast: 1,
        effect: 'throws',
    },
    {
        owner: 'Cosmoteer.Ships.Parts.Resources.InlineResourceConverterRules',
        field: 'ToQuantity',
        atLeast: 1,
        effect: 'throws',
    },
    // `ShipRenderer` divides a resolution by this and hands the result to `CreateRenderTarget`, per
    // ship, at draw time. Zero gives positive infinity, which the saturating conversion to an
    // integer turns into an `int.MaxValue` square. Only the non-positive half is decidable: where
    // "large but legal" ends is a property of the device.
    {
        owner: 'Cosmoteer.Game.ObjectIndicatorRules',
        field: 'ShipIconGlowShipScale',
        atLeast: Number.MIN_VALUE,
        effect: 'throws',
    },
];
