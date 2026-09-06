package cosmoteer.preview

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import cosmoteer.PluginPaths
import java.nio.file.Files
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.SwingConstants

/**
 * The JCEF page one of this plugin's tool windows shows. It owns the browser, the queue that holds
 * messages until the page reports `ready`, the page shell with the bundled stylesheet and script and
 * the VS Code API shim they expect, and the notice shown where JCEF is unavailable.
 *
 * @param title the page's title.
 * @param media the base name of the bundled stylesheet and script, without the extension.
 * @param body the page's body markup, which the shim and the script follow.
 * @param offScreenRendering whether Chromium renders off screen, or null to leave the platform to
 *        decide. A page drawing through the GPU has to turn it off, since those layers never reach
 *        the software-composited frame.
 * @param unavailableNotice what the tool window says where JCEF is not supported.
 * @param log where a message from the page that cannot be read is reported.
 * @param badMessageNotice how that report reads.
 * @param onMessage what the page's own messages mean, `ready` aside.
 */
class JcefPageHost(
    private val title: String,
    private val media: String,
    private val body: String,
    private val offScreenRendering: Boolean?,
    private val unavailableNotice: String,
    private val log: Logger,
    private val badMessageNotice: String,
    private val onMessage: (JsonObject) -> Unit,
) {
    private var browser: JBCefBrowser? = null
    private var fallback: JComponent? = null

    /** Whether the page reported `ready`. Messages posted earlier are queued. */
    @Volatile private var pageReady = false

    @Volatile private var queuedMessage: String? = null

    /**
     * The Swing component the tool window shows.
     *
     * @returns the browser, or a notice when JCEF is unavailable.
     */
    fun component(): JComponent {
        if (!JBCefApp.isSupported()) {
            return fallback ?: JLabel(unavailableNotice, SwingConstants.CENTER).also { fallback = it }
        }
        return ensureBrowser().component
    }

    /**
     * Dispatches a message into the page, queueing it until the page has reported `ready`.
     *
     * @param json the message body, already serialized.
     */
    fun post(json: String) {
        val cefBrowser = ensureBrowserOnEdt() ?: return
        if (!pageReady) {
            queuedMessage = json
            return
        }
        cefBrowser.cefBrowser.executeJavaScript(
            "window.dispatchEvent(new MessageEvent('message', {data: $json}));",
            cefBrowser.cefBrowser.url,
            0
        )
    }

    /**
     * Whether the page is up and listening, for a message not worth creating the browser for.
     *
     * @returns true once the loaded page has reported `ready`.
     */
    fun isReady(): Boolean = browser != null && pageReady

    /** Lets go of the browser, which the owning service does when it is disposed. */
    fun dispose() {
        browser = null
    }

    /**
     * [ensureBrowser], hopping to the EDT when needed.
     *
     * @returns the browser, or null when JCEF is unsupported.
     */
    private fun ensureBrowserOnEdt(): JBCefBrowser? {
        if (!JBCefApp.isSupported()) return null
        browser?.let { return it }
        var created: JBCefBrowser? = null
        ApplicationManager.getApplication().invokeAndWait { created = ensureBrowser() }
        return created
    }

    /**
     * Creates the browser and loads the page on first use.
     *
     * @returns the browser.
     */
    private fun ensureBrowser(): JBCefBrowser {
        browser?.let { return it }
        val builder = JBCefBrowser.createBuilder()
        if (offScreenRendering != null) builder.setOffScreenRendering(offScreenRendering)
        val newBrowser = builder.build()
        val query = JBCefJSQuery.create(newBrowser as JBCefBrowserBase)
        query.addHandler { raw ->
            onPageMessage(raw)
            null
        }
        newBrowser.loadHTML(pageHtml(query))
        browser = newBrowser
        return newBrowser
    }

    /**
     * Handles messages the page sends through the shimmed `acquireVsCodeApi().postMessage`.
     *
     * @param raw the message as the page serialized it.
     */
    private fun onPageMessage(raw: String) {
        try {
            val message = JsonParser.parseString(raw).asJsonObject
            if (message.get("type")?.asString == "ready") {
                pageReady = true
                queuedMessage?.let { pending ->
                    queuedMessage = null
                    post(pending)
                }
                return
            }
            onMessage(message)
        } catch (exception: Exception) {
            log.warn(badMessageNotice, exception)
        }
    }

    /**
     * The page shell: the bundled stylesheet and script inlined, plus the VS Code API shim.
     *
     * @param query the bridge the page's `postMessage` calls into.
     * @returns the whole page.
     */
    private fun pageHtml(query: JBCefJSQuery): String {
        val css = Files.readString(PluginPaths.media("$media.css"))
        val script = Files.readString(PluginPaths.media("$media.js"))
        val bridge = query.inject("JSON.stringify(m)")
        return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>$css</style>
<style>${JcefSupport.themeCss()}</style>
<title>$title</title>
</head>
<body>
$body
<script>
window.acquireVsCodeApi = function () {
    return {
        postMessage: function (m) { $bridge },
        getState: function () { return undefined; },
        setState: function () {}
    };
};
</script>
<script>$script</script>
</body>
</html>"""
    }
}
