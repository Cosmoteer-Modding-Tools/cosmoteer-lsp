package file

import com.intellij.lang.Language

object RulesLanguage : Language("Rules") {
    private fun readResolve(): Any = RulesLanguage
    override fun getDisplayName() = "Rules"
    override fun getID() = "Rules"
    override fun getAssociatedFileType() = RulesFileType
}