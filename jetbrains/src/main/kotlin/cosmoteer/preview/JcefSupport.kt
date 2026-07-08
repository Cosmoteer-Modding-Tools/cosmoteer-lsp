package cosmoteer.preview

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBFont
import com.intellij.util.ui.UIUtil
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.Base64
import javax.swing.UIManager

/**
 * Shared plumbing for the plugin's JCEF pages (the shader preview and the part grid editor): the
 * IDE-theme-to-`--vscode-*` variable mapping the shared stylesheets read, and the data-URI image
 * inlining the pages need because JCEF pages have no filesystem access.
 */
object JcefSupport {
    /** The largest image inlined as a data URI, matching the VS Code client's cap. */
    private const val MAX_IMAGE_BYTES = 16L * 1024 * 1024

    /**
     * The `--vscode-*` variables the stylesheets read, resolved from the IDE theme. VS Code's
     * webview host injects these. JCEF has no such host, so without them every `var()` falls back
     * to the browser defaults (black on white) and the page is unreadable in a dark theme.
     */
    fun themeCss(): String {
        val toHex = { color: java.awt.Color -> String.format("#%02x%02x%02x", color.red, color.green, color.blue) }
        val background = toHex(UIUtil.getPanelBackground())
        val foreground = toHex(UIUtil.getLabelForeground())
        val description = toHex(UIUtil.getContextHelpForeground())
        val border = toHex(JBColor.border())
        val inputBackground = toHex(UIManager.getColor("TextField.background") ?: UIUtil.getPanelBackground())
        val buttonBackground = toHex(UIManager.getColor("Button.default.startBackground") ?: java.awt.Color(0x36, 0x58, 0x80))
        val buttonForeground = toHex(UIManager.getColor("Button.default.foreground") ?: java.awt.Color.WHITE)
        val labelFont = JBFont.label()
        val editorFont = EditorColorsManager.getInstance().globalScheme.editorFontName
        return """
:root {
    --vscode-font-family: '${labelFont.family}', sans-serif;
    --vscode-font-size: ${labelFont.size}px;
    --vscode-foreground: $foreground;
    --vscode-descriptionForeground: $description;
    --vscode-panel-border: $border;
    --vscode-widget-border: $border;
    --vscode-editor-background: $background;
    --vscode-editorWidget-background: $inputBackground;
    --vscode-input-background: $inputBackground;
    --vscode-input-foreground: $foreground;
    --vscode-input-border: $border;
    --vscode-button-background: $buttonBackground;
    --vscode-button-foreground: $buttonForeground;
    --vscode-button-secondaryBackground: $inputBackground;
    --vscode-button-secondaryForeground: $foreground;
    --vscode-badge-background: $border;
    --vscode-badge-foreground: $foreground;
    --vscode-focusBorder: $buttonBackground;
    --vscode-editorLineNumber-foreground: $description;
    --vscode-editor-font-family: '$editorFont', monospace;
}
body {
    background: $background;
    color: $foreground;
}
"""
    }

    /** Parses a `file:` URI into a filesystem path, null when it cannot be parsed. */
    fun uriToPath(uri: String): Path? = try {
        Paths.get(java.net.URI(uri))
    } catch (_: Exception) {
        null
    }

    /**
     * Reads an image into a `data:` URI so a page can show it without filesystem access.
     * Returns null when the file is missing, too large, or not a supported image kind.
     */
    fun imageDataUri(fileUri: String): String? {
        val path = uriToPath(fileUri) ?: return null
        return try {
            if (Files.size(path) > MAX_IMAGE_BYTES) return null
            val mime = when (path.toString().substringAfterLast('.').lowercase()) {
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                else -> return null
            }
            "data:$mime;base64," + Base64.getEncoder().encodeToString(Files.readAllBytes(path))
        } catch (_: Exception) {
            null
        }
    }
}
