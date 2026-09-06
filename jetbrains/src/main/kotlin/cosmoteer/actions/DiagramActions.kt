package cosmoteer.actions

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import cosmoteer.diagram.DiagramKind
import cosmoteer.diagram.DiagramService

/**
 * The two drawn views, each opened for the file and caret the action was invoked on. They share one
 * tool window, so invoking the second replaces what the first drew. Mirrors the VS Code
 * `cosmoteer.showResourceFlow` and `cosmoteer.showEffectChain` commands.
 */
abstract class DiagramAction(private val kind: DiagramKind) : RulesFileAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val offset = event.getData(CommonDataKeys.EDITOR)?.caretModel?.offset ?: 0
        DiagramService.getInstance(project).show(kind, file, offset)
    }
}

/** Draws the resource wiring of the part at the caret. */
class ShowResourceFlowAction : DiagramAction(DiagramKind.RESOURCE_FLOW)

/** Draws the firing chain of the part at the caret. */
class ShowEffectChainAction : DiagramAction(DiagramKind.EFFECT_CHAIN)
