package cosmoteer.textmate

import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import cosmoteer.PluginPaths
import org.jetbrains.plugins.textmate.TextMateService
import org.jetbrains.plugins.textmate.configuration.TextMateUserBundlesSettings

/**
 * Registers the staged TextMate bundle (grammars for `.rules` and `.shader`) on startup, giving
 * the files their base highlighting. LSP semantic tokens overlay it. Registration is idempotent,
 * the bundle map is keyed by path.
 */
class TextMateBundleActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        try {
            val bundlePath = PluginPaths.textMateBundle().toString()
            val settings = TextMateUserBundlesSettings.getInstance() ?: return
            if (settings.bundles.keys.any { it.equals(bundlePath, ignoreCase = true) }) return
            settings.addBundle(bundlePath, "cosmoteer-rules")
            TextMateService.getInstance().reloadEnabledBundles()
        } catch (exception: Exception) {
            logger<TextMateBundleActivity>().warn("Could not register the Cosmoteer TextMate bundle", exception)
        }
    }
}
