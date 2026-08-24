using Mono.Cecil;
using Mono.Cecil.Cil;

internal sealed partial class SchemaGen
{
    // ---- the per-method walk behind the component-slot pass (see SchemaGen.ComponentSlots.cs) ----
    // One operand stack and one local array, each value carrying the set of slots it came from. The
    // walk is not a verifier: an opcode it does not model pops and pushes by the opcode's own stack
    // behaviour and produces untagged values, which loses a tag rather than inventing one. Every
    // instruction is stepped twice so a backward branch's incoming state is seen by its target.

    /// <summary>A value on the modelled stack: which slots it came from, and what it literally is.</summary>
    sealed class SlotValue
    {
        /// <summary>An untagged value, which is everything the walk does not follow.</summary>
        public static readonly SlotValue None = new();

        /// <summary>The slot keys this value came from, null when it came from none.</summary>
        public HashSet<string>? Tags;

        /// <summary>The string this value is, for a literal, which names a read key.</summary>
        public string? Literal;

        /// <summary>The local this value is the address of, so an `out` write can be followed.</summary>
        public int LocalAddress = -1;

        /// <summary>One value carrying one slot tag.</summary>
        /// <param name="tag">The slot key.</param>
        /// <returns>The tagged value.</returns>
        public static SlotValue Of(string tag) => new() { Tags = new HashSet<string>(StringComparer.Ordinal) { tag } };

        /// <summary>The union of two values, which is what a branch join produces.</summary>
        /// <param name="left">One incoming value.</param>
        /// <param name="right">The other.</param>
        /// <returns>The merged value.</returns>
        public static SlotValue Merge(SlotValue? left, SlotValue? right)
        {
            if (left == null) return right ?? None;
            if (right == null) return left;
            if (left.Tags == null && right.Tags == null) return None;
            var tags = new HashSet<string>(StringComparer.Ordinal);
            if (left.Tags != null) tags.UnionWith(left.Tags);
            if (right.Tags != null) tags.UnionWith(right.Tags);
            return new SlotValue { Tags = tags, LocalAddress = left.LocalAddress >= 0 ? left.LocalAddress : right.LocalAddress };
        }
    }

    /// <summary>The modelled machine state at one point in a method body.</summary>
    sealed class SlotState
    {
        /// <summary>The operand stack, innermost last.</summary>
        public readonly List<SlotValue> Stack = new();

        /// <summary>The method's locals.</summary>
        public readonly SlotValue?[] Locals;

        /// <summary>True after a `br`, `ret` or `throw`, where the state means nothing until a join.</summary>
        public bool Unreachable;

        /// <summary>A fresh state for a body with that many locals.</summary>
        /// <param name="locals">How many locals the body declares.</param>
        public SlotState(int locals) => Locals = new SlotValue[locals];

        /// <summary>Pops one value, answering an untagged one when the modelled stack ran dry.</summary>
        /// <returns>The value.</returns>
        public SlotValue Pop()
        {
            if (Stack.Count == 0) return SlotValue.None;
            var value = Stack[^1];
            Stack.RemoveAt(Stack.Count - 1);
            return value;
        }

        /// <summary>Pushes one value.</summary>
        /// <param name="value">The value, null being the untagged one.</param>
        public void Push(SlotValue? value) => Stack.Add(value ?? SlotValue.None);

        /// <summary>Reads a local.</summary>
        /// <param name="index">The local's index.</param>
        /// <returns>Its value, untagged when out of range or never written.</returns>
        public SlotValue GetLocal(int index) =>
            index >= 0 && index < Locals.Length && Locals[index] != null ? Locals[index]! : SlotValue.None;

        /// <summary>Writes a local, overwriting rather than merging, since the decompiler reuses one.</summary>
        /// <param name="index">The local's index.</param>
        /// <param name="value">The value written.</param>
        public void SetLocal(int index, SlotValue value)
        {
            if (index >= 0 && index < Locals.Length) Locals[index] = value;
        }

        /// <summary>A copy, so a branch target keeps the state as it was at the branch.</summary>
        /// <returns>The copy.</returns>
        public SlotState Clone()
        {
            var copy = new SlotState(Locals.Length) { Unreachable = Unreachable };
            copy.Stack.AddRange(Stack);
            Array.Copy(Locals, copy.Locals, Locals.Length);
            return copy;
        }

        /// <summary>
        /// The join of two states. Stacks of different depths are dropped rather than merged, since a
        /// disagreement there means the walk lost track and a merged stack would be fiction.
        /// </summary>
        /// <param name="left">One incoming state.</param>
        /// <param name="right">The other.</param>
        /// <returns>The merged state.</returns>
        public static SlotState Merge(SlotState left, SlotState right)
        {
            var merged = new SlotState(Math.Max(left.Locals.Length, right.Locals.Length));
            for (var index = 0; index < merged.Locals.Length; index++)
            {
                var a = index < left.Locals.Length ? left.Locals[index] : null;
                var b = index < right.Locals.Length ? right.Locals[index] : null;
                merged.Locals[index] = SlotValue.Merge(a, b);
            }
            if (left.Stack.Count == right.Stack.Count)
                for (var index = 0; index < left.Stack.Count; index++)
                    merged.Stack.Add(SlotValue.Merge(left.Stack[index], right.Stack[index]));
            return merged;
        }
    }

    /// <summary>The methods whose generic argument names the kind a component slot must be.</summary>
    static bool IsComponentLookup(string name) => name is "GetComponent" or "TryGetComponent";

    /// <summary>Reads the local index an instruction names, whether inline or in its opcode.</summary>
    /// <param name="ins">The instruction.</param>
    /// <returns>The index, or -1 when it names none.</returns>
    static int SlotLocalIndex(Instruction ins) => ins.OpCode.Code switch
    {
        Code.Ldloc_0 or Code.Stloc_0 => 0,
        Code.Ldloc_1 or Code.Stloc_1 => 1,
        Code.Ldloc_2 or Code.Stloc_2 => 2,
        Code.Ldloc_3 or Code.Stloc_3 => 3,
        _ => ins.Operand switch
        {
            VariableDefinition variable => variable.Index,
            int index => index,
            _ => -1,
        },
    };

    /// <summary>Reads the argument index an instruction names, `this` counted as zero.</summary>
    /// <param name="ins">The instruction.</param>
    /// <param name="method">The method being walked.</param>
    /// <returns>The index, or -1 when it names none.</returns>
    static int SlotArgIndex(Instruction ins, MethodDefinition method) => ins.OpCode.Code switch
    {
        Code.Ldarg_0 => 0,
        Code.Ldarg_1 => 1,
        Code.Ldarg_2 => 2,
        Code.Ldarg_3 => 3,
        _ => ins.Operand switch
        {
            ParameterDefinition parameter => parameter.Index + (method.HasThis ? 1 : 0),
            int index => index,
            _ => -1,
        },
    };

    /// <summary>
    /// A called method's parameter type with the declaring generic instance's arguments substituted
    /// in. `Dictionary&lt;ID&lt;…&gt;, …&gt;.TryGetValue` states its parameter as `!0`, and without
    /// the substitution every map lookup of an id is lost.
    /// </summary>
    /// <param name="method">The called method reference.</param>
    /// <param name="index">The parameter's position.</param>
    /// <returns>The parameter's type as this call site sees it.</returns>
    static TypeReference SlotParamType(MethodReference method, int index)
    {
        var type = method.Parameters[index].ParameterType;
        if (type is ByReferenceType byRef) type = byRef.ElementType;
        if (type is GenericParameter parameter && parameter.Owner is TypeReference
            && method.DeclaringType is GenericInstanceType declaring
            && parameter.Position < declaring.GenericArguments.Count)
            return declaring.GenericArguments[parameter.Position];
        return type;
    }

    /// <summary>How many values an opcode pops, read from its own stack behaviour.</summary>
    /// <param name="op">The opcode.</param>
    /// <returns>The pop count.</returns>
    static int SlotPopCount(OpCode op) => op.StackBehaviourPop switch
    {
        StackBehaviour.Pop0 => 0,
        StackBehaviour.Popi or StackBehaviour.Pop1 or StackBehaviour.Popref => 1,
        StackBehaviour.Pop1_pop1 or StackBehaviour.Popi_pop1 or StackBehaviour.Popi_popi
            or StackBehaviour.Popi_popi8 or StackBehaviour.Popi_popr4 or StackBehaviour.Popi_popr8
            or StackBehaviour.Popref_pop1 or StackBehaviour.Popref_popi => 2,
        StackBehaviour.Popi_popi_popi or StackBehaviour.Popref_popi_popi or StackBehaviour.Popref_popi_popi8
            or StackBehaviour.Popref_popi_popr4 or StackBehaviour.Popref_popi_popr8
            or StackBehaviour.Popref_popi_popref => 3,
        _ => 0,
    };

    /// <summary>How many values an opcode pushes, read from its own stack behaviour.</summary>
    /// <param name="op">The opcode.</param>
    /// <returns>The push count.</returns>
    static int SlotPushCount(OpCode op) => op.StackBehaviourPush switch
    {
        StackBehaviour.Push0 => 0,
        StackBehaviour.Push1_push1 => 2,
        _ => 1,
    };

    /// <summary>
    /// Walks one method body, recording every component lookup a slot's value reaches and every
    /// member it is stored into.
    /// </summary>
    /// <param name="method">The method to walk.</param>
    void WalkForSlots(MethodDefinition method)
    {
        var body = method.Body;
        var incoming = new Dictionary<Instruction, SlotState>();
        var targets = new HashSet<Instruction>();
        foreach (var ins in body.Instructions)
        {
            if (ins.Operand is Instruction single) targets.Add(single);
            if (ins.Operand is Instruction[] many) foreach (var target in many) targets.Add(target);
        }
        foreach (var handler in body.ExceptionHandlers)
        {
            if (handler.HandlerStart != null) targets.Add(handler.HandlerStart);
            if (handler.FilterStart != null) targets.Add(handler.FilterStart);
        }

        // A constructor's id parameters are slots in their own right: a value read from a path is
        // handed to the constructor and stored on to the member the OT really names.
        if (method.IsConstructor)
            for (var index = 0; index < method.Parameters.Count; index++)
                if (ComponentIdShape(method.Parameters[index].ParameterType) != 0)
                {
                    var key = method.DeclaringType.FullName + "::#" + index;
                    slotMembers.TryAdd(key, new SlotMember(method.DeclaringType.FullName, index.ToString()));
                }

        // Two sweeps, so a target reached only by a backward branch still sees its incoming state.
        for (var sweep = 0; sweep < 2; sweep++)
        {
            var state = new SlotState(body.Variables.Count);
            foreach (var ins in body.Instructions)
            {
                if (targets.Contains(ins) && incoming.TryGetValue(ins, out var arriving))
                    state = state.Unreachable ? arriving.Clone() : SlotState.Merge(state, arriving);
                StepSlot(method, ins, state, incoming);
            }
        }
    }

    /// <summary>Hands the current state to an instruction's branch targets.</summary>
    /// <param name="ins">The branching instruction.</param>
    /// <param name="state">The state at the branch.</param>
    /// <param name="incoming">The per-target incoming states.</param>
    static void RecordBranch(Instruction ins, SlotState state, Dictionary<Instruction, SlotState> incoming)
    {
        void One(Instruction? target)
        {
            if (target == null) return;
            incoming[target] = incoming.TryGetValue(target, out var existing)
                ? SlotState.Merge(existing, state.Clone())
                : state.Clone();
        }
        if (ins.Operand is Instruction single) One(single);
        if (ins.Operand is Instruction[] many) foreach (var target in many) One(target);
    }

    /// <summary>Steps one instruction, moving tags through the modelled state.</summary>
    /// <param name="method">The method being walked.</param>
    /// <param name="ins">The instruction.</param>
    /// <param name="state">The state to advance.</param>
    /// <param name="incoming">The per-target incoming states, written by a branch.</param>
    void StepSlot(MethodDefinition method, Instruction ins, SlotState state, Dictionary<Instruction, SlotState> incoming)
    {
        switch (ins.OpCode.Code)
        {
            case Code.Ldstr:
                state.Push(new SlotValue { Literal = (string)ins.Operand });
                return;
            case Code.Ldarg or Code.Ldarg_0 or Code.Ldarg_1 or Code.Ldarg_2 or Code.Ldarg_3 or Code.Ldarg_S:
            {
                var argument = SlotArgIndex(ins, method);
                if (method.IsConstructor && argument >= 0)
                {
                    var position = argument - (method.HasThis ? 1 : 0);
                    if (position >= 0 && position < method.Parameters.Count
                        && ComponentIdShape(method.Parameters[position].ParameterType) != 0)
                    {
                        state.Push(SlotValue.Of(method.DeclaringType.FullName + "::#" + position));
                        return;
                    }
                }
                state.Push(SlotValue.None);
                return;
            }
            case Code.Ldfld or Code.Ldflda or Code.Ldsfld or Code.Ldsflda:
            {
                if (ins.OpCode.Code is Code.Ldfld or Code.Ldflda) state.Pop();
                var field = (FieldReference)ins.Operand;
                var key = SlotFieldKey(field);
                state.Push(slotMembers.ContainsKey(key) ? SlotValue.Of(key) : SlotValue.None);
                return;
            }
            case Code.Stfld or Code.Stsfld:
            {
                var value = state.Pop();
                if (ins.OpCode.Code == Code.Stfld) state.Pop();
                var field = (FieldReference)ins.Operand;
                var key = SlotFieldKey(field);
                if (value.Tags != null && slotMembers.ContainsKey(key))
                    foreach (var tag in value.Tags) RecordAliasEdge(tag, key);
                return;
            }
            case Code.Ldloc or Code.Ldloc_0 or Code.Ldloc_1 or Code.Ldloc_2 or Code.Ldloc_3 or Code.Ldloc_S:
                state.Push(state.GetLocal(SlotLocalIndex(ins)));
                return;
            case Code.Ldloca or Code.Ldloca_S:
            {
                var index = SlotLocalIndex(ins);
                state.Push(new SlotValue { Tags = state.GetLocal(index).Tags, LocalAddress = index });
                return;
            }
            case Code.Stloc or Code.Stloc_0 or Code.Stloc_1 or Code.Stloc_2 or Code.Stloc_3 or Code.Stloc_S:
                state.SetLocal(SlotLocalIndex(ins), state.Pop());
                return;
            case Code.Dup:
            {
                var value = state.Pop();
                state.Push(value);
                state.Push(value);
                return;
            }
            case Code.Ldelem_Any or Code.Ldelem_Ref or Code.Ldelema:
            {
                state.Pop();
                state.Push(state.Pop());
                return;
            }
            case Code.Call or Code.Callvirt or Code.Newobj:
                StepSlotCall(method, ins, state);
                return;
            case Code.Ret or Code.Throw or Code.Rethrow or Code.Endfinally:
                state.Stack.Clear();
                state.Unreachable = true;
                return;
            case Code.Br or Code.Br_S or Code.Leave or Code.Leave_S:
                RecordBranch(ins, state, incoming);
                state.Stack.Clear();
                state.Unreachable = true;
                return;
            case Code.Brtrue or Code.Brtrue_S or Code.Brfalse or Code.Brfalse_S:
                state.Pop();
                RecordBranch(ins, state, incoming);
                return;
            case Code.Switch:
                state.Pop();
                RecordBranch(ins, state, incoming);
                return;
            case Code.Beq or Code.Beq_S or Code.Bne_Un or Code.Bne_Un_S
                or Code.Bge or Code.Bge_S or Code.Bge_Un or Code.Bge_Un_S
                or Code.Bgt or Code.Bgt_S or Code.Bgt_Un or Code.Bgt_Un_S
                or Code.Ble or Code.Ble_S or Code.Ble_Un or Code.Ble_Un_S
                or Code.Blt or Code.Blt_S or Code.Blt_Un or Code.Blt_Un_S:
                state.Pop();
                state.Pop();
                RecordBranch(ins, state, incoming);
                return;
        }
        for (var index = 0; index < SlotPopCount(ins.OpCode); index++) state.Pop();
        for (var index = 0; index < SlotPushCount(ins.OpCode); index++) state.Push(SlotValue.None);
    }

    /// <summary>The slot key a field reference names, resolving an auto-property's backing field.</summary>
    /// <param name="field">The field reference.</param>
    /// <returns>The key.</returns>
    string SlotFieldKey(FieldReference field)
    {
        var key = field.DeclaringType.GetElementType().FullName + "::" + field.Name;
        return slotBackingFields.TryGetValue(key, out var property) ? property : key;
    }

    /// <summary>
    /// Steps a call, which is where everything happens: a getter starts a tag, a read from a path
    /// creates a key, a component lookup records the kind, and a pass-through carries the tag on.
    /// </summary>
    /// <param name="method">The method being walked.</param>
    /// <param name="ins">The call instruction.</param>
    /// <param name="state">The state to advance.</param>
    void StepSlotCall(MethodDefinition method, Instruction ins, SlotState state)
    {
        var called = (MethodReference)ins.Operand;
        var hasThis = called.HasThis && ins.OpCode.Code != Code.Newobj;
        var offset = hasThis ? 1 : 0;
        var count = called.Parameters.Count + offset;
        var arguments = new SlotValue[count];
        for (var index = count - 1; index >= 0; index--) arguments[index] = state.Pop();
        var self = hasThis && count > 0 ? arguments[0] : SlotValue.None;

        var name = called.Name;
        var generic = called as GenericInstanceMethod;
        string? kind = null;
        if (generic != null && generic.GenericArguments.Count == 1)
            kind = generic.GenericArguments[0] is GenericParameter ? null : generic.GenericArguments[0].FullName;

        // A getter over a slot member is a load of that member.
        var getterKey = called.DeclaringType.GetElementType().FullName + "::" + name;
        if (slotGetters.TryGetValue(getterKey, out var read) && called.ReturnType.FullName != "System.Void")
        {
            state.Push(new SlotValue { Tags = new HashSet<string>(read, StringComparer.Ordinal) });
            return;
        }

        // A key read from a path is a member the OT names that no C# member declares.
        var isRead = name is "TryReadFromPath" or "ReadFromPath" or "ReadOptionalFromPath" or "ReadFromPathOrDefault";
        if (isRead && generic != null && generic.GenericArguments.Count == 1
            && ComponentIdShape(generic.GenericArguments[0]) != 0)
        {
            var literal = arguments.FirstOrDefault(a => a.Literal != null)?.Literal;
            if (literal != null)
            {
                var key = method.DeclaringType.FullName + "::#" + literal;
                slotMembers.TryAdd(key, new SlotMember(method.DeclaringType.FullName, literal));
                // The read writes through an `out` local, which is how the value reaches its member.
                foreach (var argument in arguments)
                    if (argument.LocalAddress >= 0) state.SetLocal(argument.LocalAddress, SlotValue.Of(key));
                if (called.ReturnType.FullName != "System.Void" && ComponentIdShape(called.ReturnType) != 0)
                {
                    state.Push(SlotValue.Of(key));
                    return;
                }
            }
        }

        // A call that hands the value straight back, so the tag rides through it.
        var passthrough =
            (called.DeclaringType.Name.StartsWith("Nullable`", StringComparison.Ordinal)
                && name is "get_Value" or "GetValueOrDefault")
            || name is "get_Item" or "get_Current" or "GetEnumerator" or "ToArray" or "ToList"
                or "ToImmutableArray" or "AsSpan" or "get_Span" or "First" or "Last" or "ElementAt"
                or "Single" or "get_Value" or "GetValueOrDefault";

        // A value added to a tagged collection is stored into whatever that collection is.
        if (name is "Add" or "AddRange" or "Insert" && self.Tags != null)
            foreach (var argument in arguments)
                if (argument.Tags != null)
                    foreach (var tag in argument.Tags)
                        foreach (var target in self.Tags) RecordAliasEdge(tag, target);

        // The live ship's own container, and only it: the blueprint and wreck containers resolve the
        // same ids through their own lookups, where a component with no half of that kind is the
        // ordinary case rather than a mistake.
        var isLookup = IsComponentLookup(name) && called.DeclaringType.FullName == LIVE_PART;
        if (!isRead)
        {
            for (var index = 0; index < called.Parameters.Count; index++)
            {
                if (ComponentIdShape(SlotParamType(called, index)) != 1) continue;
                var tags = index + offset < arguments.Length ? arguments[index + offset].Tags : null;
                if (tags == null || !isLookup || kind == null) continue;
                foreach (var tag in tags) RecordLookup(tag, new SlotLookup(kind, name == "GetComponent"));
            }
        }

        if (ins.OpCode.Code == Code.Newobj)
        {
            for (var index = 0; index < called.Parameters.Count; index++)
            {
                var value = arguments[index + offset];
                if (value.Tags == null) continue;
                var parameterKey = called.DeclaringType.FullName + "::#" + index;
                if (!slotMembers.ContainsKey(parameterKey)) continue;
                foreach (var tag in value.Tags) RecordAliasEdge(tag, parameterKey);
            }
            state.Push(SlotValue.None);
            return;
        }
        if (called.ReturnType.FullName == "System.Void") return;
        var result = SlotValue.None;
        if (passthrough)
        {
            if (self.Tags != null) result = new SlotValue { Tags = self.Tags };
            else if (arguments.Length > 0 && arguments[0].Tags != null) result = new SlotValue { Tags = arguments[0].Tags };
        }
        state.Push(result);
    }
}
