package cosmoteer

import com.intellij.openapi.application.PluginPathManager
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/** Resolves files the build stages next to the plugin jar (server bundle, media, l10n, textmate). */
object PluginPaths {
    const val PLUGIN_ID = "cosmoteer-language-server"

    /**
     * A file the build staged in the plugin's install directory, addressed by its path relative to
     * that directory (for example `language-server/server.js`). Resolved through the sanctioned
     * public `PluginPathManager.getPluginResource`, which resolves against the plugin's dist dir
     * (JetBrains staff recommend it, and it has existed since long before the 243 floor). The direct
     * registry lookups are all off limits: every route to a plugin's path there
     * (PluginManagerCore.getPlugin, PluginManager.findEnabledPlugin, PluginManager.getPlugins,
     * PluginAwareClassLoader, PluginDescriptor.getPluginPath) is `@ApiStatus.Internal`, and JetBrains
     * keeps marking more of them so with each release. getPluginResource calls getPluginPath under
     * the hood, but that internal call is the platform's, not ours, so the verifier does not flag it.
     */
    private fun staged(relative: String): Path =
        PluginPathManager.getPluginResource(PluginPaths::class.java, relative)?.toPath()
            ?: pluginRoot().resolve(relative)

    /** The bundled language-server entry point. */
    fun serverJs(): Path = staged("language-server/server.js")

    /** A file inside the bundled webview assets folder. */
    fun media(name: String): Path = staged("media/$name")

    /** The localization bundle the server should load, following the IDE language. */
    fun l10nBundle(): Path {
        val german = staged("l10n/bundle.l10n.de.json")
        return if (java.util.Locale.getDefault().language == "de" && german.toFile().exists()) {
            german
        } else {
            staged("l10n/bundle.l10n.json")
        }
    }

    /** The staged TextMate bundle giving `.rules`/`.shader` files their base highlighting. */
    fun textMateBundle(): Path = staged("textmate/rules.tmBundle")

    /**
     * Fallback plugin-install directory used only when [staged] gets no answer from the platform.
     * Derived from this class's own code location with the JDK alone, so it can never be flagged:
     * two independent strategies for the container (jar or classes dir), then walk up to the folder
     * that holds the staged `language-server/` bundle.
     */
    private fun pluginRoot(): Path {
        val container = codeSourcePath() ?: classResourcePath()
            ?: throw IllegalStateException("Cannot locate the Cosmoteer plugin classes")
        var dir: Path? = if (Files.isDirectory(container)) container else container.parent
        while (dir != null && !Files.isDirectory(dir.resolve("language-server"))) {
            dir = dir.parent
        }
        return dir ?: throw IllegalStateException("Cosmoteer plugin installation directory not found")
    }

    /** The jar (or classes dir) this class was loaded from, via its code source. Null if unavailable. */
    private fun codeSourcePath(): Path? = try {
        PluginPaths::class.java.protectionDomain?.codeSource?.location?.let { Paths.get(it.toURI()) }
    } catch (_: Exception) {
        null
    }

    /** Same location parsed from this class's own resource URL (`jar:` or `file:`). */
    private fun classResourcePath(): Path? = try {
        val url = PluginPaths::class.java.getResource("PluginPaths.class") ?: return null
        when (url.protocol) {
            // jar:file:/…/lib/<jar>!/cosmoteer/PluginPaths.class -> the jar file itself
            "jar" -> Paths.get(java.net.URI(url.path.substringBefore("!/")))
            // file:/…/classes/cosmoteer/PluginPaths.class (exploded dev layout) -> the class file
            "file" -> Paths.get(url.toURI())
            else -> null
        }
    } catch (_: Exception) {
        null
    }
}
