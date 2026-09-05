package cosmoteer.actions

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import java.nio.file.Paths

/**
 * The uri a creation wizard finds its mod from: the file or folder the action was invoked on, which
 * is what the New submenu of the project view hands over, else the project folder, so the wizard is
 * still reachable from the Tools menu with nothing selected. The server reads a folder as a file
 * inside it, which is where the mod is looked for.
 *
 * @return the uri, or null when neither the selection nor the project has a path.
 */
fun AnActionEvent.modAnchorUri(): String? {
    val selected = getData(CommonDataKeys.VIRTUAL_FILE)
    val fromSelection = runCatching { selected?.toNioPath()?.toUri()?.toString() }.getOrNull()
    if (fromSelection != null) return fromSelection
    val base = project?.basePath ?: return null
    return runCatching { Paths.get(base).toUri().toString() }.getOrNull()
}
