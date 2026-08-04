import * as path from 'path';
import { AbstractNode, isDocumentNode, isGroupNode } from '../../core/ast/ast';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { documentRootClass } from '../../document/schema/document-root';
import { modAssemblyOfClass, typeDef } from '../../document/schema/schema';
import { globalSettings } from '../../settings';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';

/** The client-side command a decompiler hover link invokes (registered by the VS Code extension). */
export const OPEN_IN_DECOMPILER_COMMAND = 'cosmoteer.openInDecompiler';

/**
 * Markdown footer link opening the hovered node's owning C# class in the user's .NET decompiler
 * (ILSpy or dotPeek). Opt-in via `decompiler.showInHover` (off by default): the schema classes are
 * extracted from the game's assemblies, so a power user digging past what the hover documents can
 * jump straight to the class's real deserialization code.
 *
 * The link is a `command:` URI executed by the client (the VS Code extension registers the command
 * and marks the hover markdown trusted for it), carrying the assembly's absolute path and the
 * class's XML doc-ID, the form both ILSpy (`/navigateTo:`) and dotPeek (`/select=`) accept.
 * Clients that do not register the command render the link inert, which is why the server only
 * emits it when the user explicitly opted in.
 *
 * @param node the hovered node.
 * @returns the markdown link line, or null when the feature is off, no schema class resolves, or
 *          the game install (and thus the assembly path) is unknown.
 */
export const decompilerHoverLink = (node: AbstractNode): string | null => {
    if (!globalSettings.decompiler?.showInHover) return null;
    const cls = owningClassOf(node);
    if (!cls || !typeDef(cls)) return null;
    const assemblyPath = assemblyPathOf(cls);
    if (!assemblyPath) return null;

    // Cecil FullNames separate nested classes with `/`. The XML doc-ID convention both decompilers
    // navigate by uses `.` throughout.
    const docId = `T:${cls.replace(/\//g, '.')}`;
    const shortName = cls.split(/[./]/).pop();
    const args = encodeURIComponent(JSON.stringify([{ assemblyPath, docId }]));
    return `_[Open \`${shortName}\` in decompiler ↗](command:${OPEN_IN_DECOMPILER_COMMAND}?${args})_`;
};

/**
 * The assembly that declares a schema class.
 *
 * A class a code mod contributed lives in that mod's own `.dll`, which the extraction recorded when
 * it read the type, so the link opens the mod's assembly rather than a game assembly that does not
 * contain the class at all. (The decompiler resolves the mod's references to the game types on its
 * own, from the assemblies beside it and the ones already open.) Everything else comes from the two
 * assemblies the shipped schema is extracted from (see tools/schemagen): the game's own `*Rules`
 * classes in Cosmoteer.dll, the nested engine types in HalflingCore.dll.
 *
 * @param cls the class FullName.
 * @returns the absolute assembly path, or undefined when the game install is unknown.
 */
const assemblyPathOf = (cls: string): string | undefined => {
    const modAssembly = modAssemblyOfClass(cls);
    if (modAssembly) return modAssembly;
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return undefined;
    return path.join(dataRoot, '..', 'Bin', cls.startsWith('Halfling') ? 'HalflingCore.dll' : 'Cosmoteer.dll');
};

/**
 * The schema class owning the hovered node: the nearest enclosing group that resolves to a class,
 * or the document's root class for a top-level field. A hovered group-form field (`Arc { … }`)
 * resolves to its own class, which is exactly the one worth opening.
 */
const owningClassOf = (node: AbstractNode): string | undefined => {
    let cur: AbstractNode | undefined = node;
    while (cur) {
        if (isGroupNode(cur)) {
            const cls = resolveGroupClass(cur);
            if (cls) return cls;
        }
        if (isDocumentNode(cur)) return documentRootClass(cur);
        cur = cur.parent;
    }
    return undefined;
};
