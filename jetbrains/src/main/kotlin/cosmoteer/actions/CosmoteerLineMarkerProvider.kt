package cosmoteer.actions

import com.intellij.codeInsight.daemon.LineMarkerInfo
import com.intellij.codeInsight.daemon.LineMarkerProvider
import com.intellij.icons.AllIcons
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import cosmoteer.preview.ShaderPreviewService

/**
 * Gutter markers standing in for the VS Code CodeLenses: a preview marker on every
 * `Shader = "….shader"` assignment and an overview marker at the top of a mod manifest. Like the
 * VS Code providers this is a light line scan, the server does the real work when clicked.
 */
class CosmoteerLineMarkerProvider : LineMarkerProvider {
    override fun getLineMarkerInfo(element: PsiElement): LineMarkerInfo<*>? {
        if (element.firstChild != null) return null
        val file = element.containingFile?.virtualFile ?: return null
        if (!file.name.endsWith(".rules", ignoreCase = true)) return null
        val range = element.textRange ?: return null
        val document = element.containingFile.viewProvider.document ?: return null

        if (range.startOffset == 0 && isModManifest(file)) {
            return LineMarkerInfo(
                element,
                TextRange(range.startOffset, range.startOffset + 1),
                AllIcons.Actions.Preview,
                { "Show mod overview" },
                { _, marked -> showModOverview(marked.project, file) },
                GutterIconRenderer.Alignment.LEFT
            ) { "Show mod overview" }
        }

        val line = document.getLineNumber(range.startOffset)
        val lineStart = document.getLineStartOffset(line)
        val lineText = document.getText(TextRange(lineStart, document.getLineEndOffset(line)))
        if (!SHADER_LINE.containsMatchIn(lineText)) return null
        // Only the line's first non-whitespace leaf carries the marker, so it appears once per line.
        val contentStart = lineStart + (lineText.length - lineText.trimStart().length)
        if (range.startOffset != contentStart) return null
        return LineMarkerInfo(
            element,
            TextRange(contentStart, contentStart + 1),
            AllIcons.Actions.Execute,
            { "Preview shader" },
            { _, marked -> ShaderPreviewService.getInstance(marked.project).preview(file, contentStart) },
            GutterIconRenderer.Alignment.LEFT
        ) { "Preview shader" }
    }

    companion object {
        /** Matches a `Shader = "x.shader"` assignment line, same as the VS Code lens provider. */
        private val SHADER_LINE = Regex("^\\s*Shader\\s*=\\s*\"?[^\"\\n]+\\.shader")
    }
}
