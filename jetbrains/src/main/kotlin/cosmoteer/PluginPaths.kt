package cosmoteer

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import java.nio.file.Path

/** Resolves files the build stages next to the plugin jar (server bundle, media, l10n, textmate). */
object PluginPaths {
    const val PLUGIN_ID = "cosmoteer-language-server"

    /** The plugin's installation directory, the parent of its `lib/` folder. */
    fun pluginRoot(): Path =
        PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath
            ?: throw IllegalStateException("Cosmoteer plugin installation directory not found")

    /** The bundled language-server entry point. */
    fun serverJs(): Path = pluginRoot().resolve("language-server").resolve("server.js")

    /** A file inside the bundled webview assets folder. */
    fun media(name: String): Path = pluginRoot().resolve("media").resolve(name)

    /** The localization bundle the server should load, following the IDE language. */
    fun l10nBundle(): Path {
        val german = pluginRoot().resolve("l10n").resolve("bundle.l10n.de.json")
        val english = pluginRoot().resolve("l10n").resolve("bundle.l10n.json")
        return if (java.util.Locale.getDefault().language == "de" && german.toFile().exists()) german else english
    }

    /** The staged TextMate bundle giving `.rules`/`.shader` files their base highlighting. */
    fun textMateBundle(): Path = pluginRoot().resolve("textmate").resolve("rules.tmBundle")
}
