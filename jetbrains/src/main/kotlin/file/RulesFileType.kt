package file

import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.openapi.util.IconLoader

object RulesFileType : LanguageFileType(RulesLanguage) {
    override fun getName() = "Rules"
    override fun getDescription() = "Rules language file"
    override fun getDefaultExtension() = "rules"
    override fun getIcon() = IconLoader.getIcon("/icons/rules.png", javaClass)
}