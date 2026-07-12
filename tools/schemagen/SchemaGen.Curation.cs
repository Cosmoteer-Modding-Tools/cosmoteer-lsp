using System.Text.Json.Nodes;

internal sealed partial class SchemaGen
{
    // Extra spellings the Halfling OT deserializer accepts for an enum beyond its C# member names, when
    // they carry no alias attribute to extract. Validated against the vanilla scan: e.g. particle data
    // fields write `DataType = Vector2D` for the `Vector2` member, so without this the 29 vanilla files
    // using it would false-positive. Keep entries evidence-based (a spelling vanilla actually uses).
    readonly Dictionary<string, string[]> enumAliases = new()
    {
        ["Halfling.Particles.ParticleDataType"] = new[] { "Vector2D" },
    };

    // The OT name a reflective field is written under when it differs from its C# member name and no
    // `[Serialize(Alias=…)]` carries it. The float colour components serialize as `Rf`/`Gf`/`Bf`/`Af`
    // (vanilla writes them ~1900×) while the C# fields are `R`/`G`/`B`/`A`; without this, completion and
    // hover inside a `Color { … }` offer the wrong names. The original member name is kept as an alias.
    // Keyed by declaring type FullName, then C# member name → OT name. Evidence-based (a spelling vanilla
    // actually uses); a wrong entry would surface as a vanilla mis-hint, not a false diagnostic.
    readonly Dictionary<string, Dictionary<string, string>> fieldNameOverrides = new()
    {
        ["Halfling.Graphics.Color"] = new() { ["R"] = "Rf", ["G"] = "Gf", ["B"] = "Bf", ["A"] = "Af" },
    };

    // Abstract sprite/material interfaces that are always deserialized as a single concrete class. A field
    // typed as the interface is rewritten to reference the concrete impl, which carries the full field set
    // (the interface reflects only a subset). `Sprite`/`Material` are extracted normally; `AnimatedSprite`
    // is a curated type (its frame fields are custom-deserialized, no `[Serialize]`).
    readonly Dictionary<string, (string full, string name)> ConcreteImpl = new()
    {
        ["Halfling.Graphics.ISprite"] = ("Halfling.Graphics.Sprite", "Sprite"),
        ["Halfling.Graphics.IMaterial"] = ("Halfling.Graphics.Material", "Material"),
        ["Halfling.Graphics.IAnimatedSprite"] = ("Halfling.Graphics.AnimatedSprite", "AnimatedSprite"),
    };

    // Engine value types that are deserialized inline — they have no `[Serialize]` members (a custom
    // deserializer reads sibling keys from the parent), so reflection yields an `opaque` blob and the
    // real fields are invisible. A particle updater's `Range` (`FlexRange`) is written as `ValueType` +
    // `FromValue` + `ToValue` directly in the updater group, and `Value` (`FlexValue`) as `ValueType` +
    // `Value`. We splice those fields into the parent at extraction time (keyed by the opaque type name),
    // so completion/hover see them. The component values are runtime-polymorphic on `ValueType`
    // (Angle→number, Vector2→group, Color→{Rf…}), so they stay permissive (`opaque`, no validation); only
    // `ValueType` is a closed enum, kept honest by the vanilla scan.
    const string FLEX_VALUE_TYPE = "Halfling.Particles.Updaters.FlexValueType";
    static JsonObject Field(string name, JsonObject valueType) => new() { ["name"] = name, ["valueType"] = valueType, ["optional"] = true };
    static JsonObject EnumRef(string fullName) => new() { ["kind"] = "enum", ["ref"] = fullName, ["name"] = fullName.Split('.').Last() };
    static JsonObject OpaqueRef(string type) => new() { ["kind"] = "opaque", ["type"] = type };
    readonly Dictionary<string, Func<JsonObject[]>> inlineFieldExpansions = new()
    {
        ["FlexRange"] = () => new[] { Field("ValueType", EnumRef(FLEX_VALUE_TYPE)), Field("FromValue", OpaqueRef("FlexValueComponent")), Field("ToValue", OpaqueRef("FlexValueComponent")) },
        ["FlexValue"] = () => new[] { Field("ValueType", EnumRef(FLEX_VALUE_TYPE)), Field("Value", OpaqueRef("FlexValueComponent")) },
    };

    // The modification mode of an inline buff/status/effect-scale modifier inside a Modifiable group form.
    // The enum (`Cosmoteer.Ships.ValueModificationMode`) is `internal` and reached only through the
    // custom inline-modifier deserializer (no `[Serialize]` slot), so it is curated from the decompiled
    // member list and kept honest by the vanilla scan.
    const string VALUE_MOD_MODE = "Cosmoteer.Ships.ValueModificationMode";
    const string MODIFIABLE_VALUE = "Cosmoteer.Ships.ModifiableValue";
    const string PART_CONVERSION = "Cosmoteer.Generators.Ships.Stages.ConvertTypeStage/PartConversion";
    // When an animated AtlasSprite's animation clock starts. Nested enum reached only via the sprite's
    // custom deserializer (no `[Serialize]` slot), so curated from the decompiled member list.
    const string ANIM_START_MODE = "Cosmoteer.Ships.Rendering.AtlasSprite/AnimStartTimeMode";
    // A font definition group (`DefaultFont { File=… Passes […] }`), read by the global FontFactory
    // deserializer. Group-only: the reader throws on a scalar, so the mapping is a plain group.
    const string FONT_CLASS = "Halfling.Graphics.Text.Font";
    // A cursor group (`{ File=… HotSpot=[8,8] Scale=.5 }` or `{ OSCursor=Arrow }`), read by the
    // CursorManager deserializer. Group-only, like Font.
    const string CURSOR_CLASS = "Halfling.Windows.Cursor";
    const string OSCURSOR_ENUM = "Halfling.Windows.OSCursor";

    void SeedCuratedEnums()
    {
        // The `ValueType` discriminator a FlexRange/FlexValue carries. No reflective enum is reachable for it
        // (the type is custom-deserialized), so it is curated from the vanilla vocabulary plus the sibling
        // dimensional names; the 954-file scan keeps it false-positive-free.
        enums[FLEX_VALUE_TYPE] = new JsonObject
        {
            ["name"] = "FlexValueType",
            ["members"] = new JsonArray("Float", "Int", "Angle", "Color", "Vector2", "Vector2D", "Vector3", "Vector4", "IntVector2", "IntVector3", "IntVector4", "Interpolated", "Raw"),
        };
        enums[VALUE_MOD_MODE] = new JsonObject
        {
            ["name"] = "ValueModificationMode",
            ["members"] = new JsonArray("Replace", "Add", "Subtract", "Multiply", "Divide", "Lerp", "ReverseLerp"),
        };
        enums[ANIM_START_MODE] = new JsonObject
        {
            ["name"] = "AnimStartTimeMode",
            ["members"] = new JsonArray("Zero", "MinValue", "WhenSpawned", "Random", "Default"),
        };
        // The operating-system cursors a Cursor group can name (`OSCursor = Arrow`). A real public
        // enum in HalflingCore, but reached only through the CursorManager deserializer (no
        // `[Serialize]` slot), so curated from the decompiled member list.
        enums[OSCURSOR_ENUM] = new JsonObject
        {
            ["name"] = "OSCursor",
            ["members"] = new JsonArray(
                "AppStarting", "Arrow", "Cross", "Default", "Hand", "Help", "HorizontalSplit", "IBeam",
                "No", "NoMove2D", "NoMoveHorizontal", "NoMoveVertical", "PanEast", "PanNE", "PanNorth",
                "PanNW", "PanSE", "PanSouth", "PanSW", "PanWest", "SizeAll", "SizeNESW", "SizeNS",
                "SizeNWSE", "SizeWE", "UpArrow", "VerticalSplit", "Wait"),
        };
    }

    // ---- curated synthetic group types ----
    // A few structs are deserialized field-by-field but carry no [Serialize]/[ReflectiveSerialization]
    // (plain public fields read by a custom ObjectTextConstructor), so reflection can't see their shape
    // and they would land as opaque. Their field set is fixed and unambiguous, so we inject it here and
    // point the matching MapType case at it. A struct written as either a scalar or a group (Modifiable,
    // DirectionalCrewSpeeds) keeps a scalar primary kind whose `groupForm` names the curated class, so
    // both written forms complete and validate. The reachability prune keeps these only if actually used.
    static JsonObject CuratedField(string name, JsonObject valueType) =>
        new() { ["name"] = name, ["valueType"] = valueType, ["optional"] = false };
    static JsonObject GroupOf(string fullName, string name) => new() { ["kind"] = "group", ["ref"] = fullName, ["name"] = name };
    static JsonObject OptField(string name, JsonObject valueType) => new() { ["name"] = name, ["valueType"] = valueType, ["optional"] = true };
    static JsonObject NumberType() => new() { ["kind"] = "number" };
    static JsonObject RefType(string target, string name) => new() { ["kind"] = "reference", ["target"] = target, ["targetName"] = name };
    static JsonObject ModeEnum() => new() { ["kind"] = "enum", ["ref"] = VALUE_MOD_MODE, ["name"] = "ValueModificationMode" };
    static JsonObject AssetImage() => new() { ["kind"] = "asset", ["assetKind"] = "image" };
    static JsonObject ListOfImages() => new() { ["kind"] = "list", ["element"] = AssetImage() };
    static JsonObject Vector2Type() => GroupOf("Halfling.Geometry.Vector2", "Vector2");
    static JsonObject BoolType() => new() { ["kind"] = "bool" };
    static JsonObject IntType2() => new() { ["kind"] = "int" };
    static JsonObject IntVec2() => GroupOf("Halfling.Geometry.IntVector2", "IntVector2");

    void AddCuratedTypes()
    {
        // VirtualInternalCell: always `{ ExternalCell=[x, y]; InternalCell=[x, y] }`, both IntVector2.
        types["Cosmoteer.Ships.Parts.VirtualInternalCell"] = new JsonObject
        {
            ["name"] = "VirtualInternalCell",
            ["namespace"] = "Cosmoteer.Ships.Parts",
            ["fields"] = new JsonArray(
                CuratedField("ExternalCell", GroupOf("Halfling.Geometry.IntVector2", "IntVector2")),
                CuratedField("InternalCell", GroupOf("Halfling.Geometry.IntVector2", "IntVector2")))
        };
        // ModifiableValue: the group form of a Modifiable<T> field (the `groupForm` target above). Its
        // reflective members are BaseValue/Modifiers/MinValue/MaxValue; the buff/status/effect-scale keys are
        // read inline by the custom deserializer (`_TryReadInlineModifierData`). BaseValue/Min/Max are the
        // generic `T`, modeled as a plain `number` (good for any variant). Modifiers points at the real
        // `[SerialBaseType]` registry on `Cosmoteer.Ships.ValueModifier`, whose derived classes the normal
        // reflection harvest emits (BuffRemap, StatusRemap, NamedValue, ...), so entries complete and
        // validate like every other `Type=` group. All optional — the scalar shorthand is the common form,
        // so none of these is required.
        types[MODIFIABLE_VALUE] = new JsonObject
        {
            ["name"] = "ModifiableValue",
            ["namespace"] = "Cosmoteer.Ships",
            ["fields"] = new JsonArray(
                OptField("BaseValue", NumberType()),
                OptField("Modifiers", new JsonObject
                {
                    ["kind"] = "list",
                    ["element"] = new JsonObject { ["kind"] = "polymorphicGroup", ["ref"] = "Cosmoteer.Ships.ValueModifier", ["name"] = "ValueModifier" },
                }),
                OptField("MinValue", NumberType()),
                OptField("MaxValue", NumberType()),
                OptField("BuffType", RefType("Cosmoteer.Ships.Buffs.BuffType", "BuffType")),
                OptField("BuffMode", ModeEnum()),
                OptField("BuffMinValue", NumberType()),
                OptField("BuffMaxValue", NumberType()),
                OptField("StatusType", RefType("Cosmoteer.Ships.Statuses.StatusType", "StatusType")),
                OptField("StatusMode", ModeEnum()),
                OptField("StatusMinValue", NumberType()),
                OptField("StatusMaxValue", NumberType()),
                OptField("EffectScaleExponent", NumberType()),
                OptField("EffectScaleMode", ModeEnum()))
        };
        // Font: the definition group the global FontFactory deserializer reads (widgets.rules
        // `DefaultFont { … }` and every `Font`-typed slot). Keys transcribed from FontFactory.Read:
        // `File`/`Files` (the ttf sources, one of the two present), `Passes` (render passes, whose
        // `Effects` reach the real IFontEffect `Type=` registry through the normal harvest),
        // `ForceSameWidths` (a key-string/value-string pair) and `AntialiasQuality`. All read via
        // Try/optional paths except the File-or-Files choice, which is not provable, so all optional.
        types[FONT_CLASS] = new JsonObject
        {
            ["name"] = "Font",
            ["namespace"] = "Halfling.Graphics.Text",
            ["fields"] = new JsonArray(
                OptField("File", new JsonObject { ["kind"] = "asset", ["assetKind"] = "font" }),
                OptField("Files", new JsonObject
                {
                    ["kind"] = "list",
                    ["element"] = new JsonObject { ["kind"] = "asset", ["assetKind"] = "font" },
                }),
                OptField("Passes", new JsonObject
                {
                    ["kind"] = "list",
                    ["element"] = GroupOf("Halfling.Graphics.Text.FontRenderPass", "FontRenderPass"),
                }),
                OptField("ForceSameWidths", new JsonObject
                {
                    ["kind"] = "tuple",
                    ["elements"] = new JsonArray(
                        new JsonObject { ["kind"] = "string" },
                        new JsonObject { ["kind"] = "string" }),
                }),
                OptField("AntialiasQuality", IntType2()))
        };
        // Cursor: the group the CursorManager deserializer reads. Either a bitmap cursor
        // (`File` + optional `HotSpot`/`Scale`) or an operating-system cursor (`OSCursor = Arrow`).
        types[CURSOR_CLASS] = new JsonObject
        {
            ["name"] = "Cursor",
            ["namespace"] = "Halfling.Windows",
            ["fields"] = new JsonArray(
                OptField("File", AssetImage()),
                OptField("HotSpot", IntVec2()),
                OptField("Scale", NumberType()),
                OptField("OSCursor", new JsonObject { ["kind"] = "enum", ["ref"] = OSCURSOR_ENUM, ["name"] = "OSCursor" }))
        };
        // PartConversion: `record struct PartConversion(ID<PartRules> From, ID<PartRules> To)`, the entries
        // of a sysgen ConvertTypeStage's `Conversions` list. Written as `{ From = <part id>  To = <part id> }`
        // (see vanilla `doodads/asteroids/hard_conversions.rules`), both required by the positional record.
        types[PART_CONVERSION] = new JsonObject
        {
            ["name"] = "PartConversion",
            ["namespace"] = "Cosmoteer.Generators.Ships.Stages",
            ["fields"] = new JsonArray(
                CuratedField("From", RefType("Cosmoteer.Ships.Parts.PartRules", "PartRules")),
                CuratedField("To", RefType("Cosmoteer.Ships.Parts.PartRules", "PartRules")))
        };
        // AtlasSprite: the engine's quad-sprite, a custom-deserialized group (`IObjectTextContentDeserializable`,
        // no `[Serialize]` members) so reflection yields an empty field set. It is referenced as a group by
        // ~5700 vanilla field-slots (every `…Sprite { File=… Size=… }`), so its fields are transcribed from
        // the deserializer (`ReadContentFrom`) here. All optional (every key is read with Try/ReadOptional).
        types["Cosmoteer.Ships.Rendering.AtlasSprite"] = new JsonObject
        {
            ["name"] = "AtlasSprite",
            ["namespace"] = "Cosmoteer.Ships.Rendering",
            ["fields"] = new JsonArray(
                OptField("File", AssetImage()),
                OptField("AnimationFiles", ListOfImages()),
                OptField("NormalsFile", AssetImage()),
                OptField("NormalsAnimationFiles", ListOfImages()),
                OptField("Size", Vector2Type()),
                OptField("Offset", Vector2Type()),
                OptField("Z", NumberType()),
                OptField("VertexColor", GroupOf("Halfling.Graphics.Color", "Color")),
                OptField("UVRotation", new JsonObject { ["kind"] = "int" }),
                OptField("MirrorU", BoolType()),
                OptField("MirrorV", BoolType()),
                OptField("AnimationInterval", NumberType()),
                OptField("AnimationStartTime", new JsonObject { ["kind"] = "enum", ["ref"] = ANIM_START_MODE, ["name"] = "AnimStartTimeMode" }),
                OptField("ClampAnimation", BoolType()),
                OptField("RotSpeed", NumberType()),
                // Texture-loading options the sprite reads inline alongside its `File`.
                OptField("SampleMode", new JsonObject { ["kind"] = "enum", ["ref"] = "Halfling.Graphics.TextureSampleMode", ["name"] = "TextureSampleMode" }),
                OptField("MipLevels", new JsonObject { ["kind"] = "string", ["semantic"] = "mipLevels" }),
                OptField("FixTransparentColors", BoolType()),
                OptField("PreMultiplyByAlpha", BoolType()))
        };
        // AnimatedSprite: the concrete IAnimatedSprite impl (IGenericContentDeserializable, no `[Serialize]`).
        // Either splits a source `AtlasSprite` into FrameCount frames of FrameSize, or takes explicit `Frames`,
        // with a `Duration`/`FramesPerSecond`/`Interval` clock and a `WrapMode`. Transcribed from its
        // ReadContentFrom; the `IAnimatedSprite` slot resolves here (see CONCRETE_IMPL in schema-context.ts).
        types["Halfling.Graphics.AnimatedSprite"] = new JsonObject
        {
            ["name"] = "AnimatedSprite",
            ["namespace"] = "Halfling.Graphics",
            ["fields"] = new JsonArray(
                OptField("AtlasSprite", GroupOf("Halfling.Graphics.Sprite", "Sprite")),
                OptField("FrameCount", IntType2()),
                OptField("FrameSize", IntVec2()),
                OptField("FramePadding", IntVec2()),
                OptField("FramesOffset", IntVec2()),
                OptField("FramesPerRow", IntType2()),
                OptField("Frames", new JsonObject { ["kind"] = "list", ["element"] = GroupOf("Halfling.Graphics.Sprite", "Sprite") }),
                OptField("Duration", NumberType()),
                OptField("FramesPerSecond", NumberType()),
                OptField("Interval", NumberType()),
                OptField("WrapMode", new JsonObject { ["kind"] = "enum", ["ref"] = "Halfling.Graphics.AnimationWrapMode", ["name"] = "AnimationWrapMode" }))
        };
    }
}
