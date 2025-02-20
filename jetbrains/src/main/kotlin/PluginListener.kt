import com.intellij.ide.plugins.DynamicPluginListener
import com.intellij.ide.plugins.IdeaPluginDescriptor
import com.intellij.lang.javascript.service.JSLanguageServiceUtil
import org.jetbrains.plugins.textmate.TextMateService
import org.jetbrains.plugins.textmate.configuration.TextMateUserBundlesSettings

internal class PluginListener : DynamicPluginListener {
    override fun pluginLoaded(pluginDescriptor: IdeaPluginDescriptor) {
        val textMateBundle = JSLanguageServiceUtil.getPluginDirectory(javaClass, "ressources/rules.tmLanguage.json")
            ?: throw Exception()
        println(textMateBundle.exists())
        TextMateUserBundlesSettings.getInstance()?.addBundle(textMateBundle.path, "rules")
        TextMateService.getInstance().reloadEnabledBundles();
    }

    override fun pluginUnloaded(pluginDescriptor: IdeaPluginDescriptor, isUpdate: Boolean) {
        val textMateBundle = JSLanguageServiceUtil.getPluginDirectory(javaClass, "ressources/rules.tmLanguage.json")
            ?: throw Exception()
        TextMateUserBundlesSettings.getInstance()?.disableBundle(textMateBundle.path);
        TextMateService.getInstance().reloadEnabledBundles();
    }
}