package cosmoteer.file

import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.util.IconLoader
import org.jetbrains.plugins.textmate.TextMateBackedFileType
import javax.swing.Icon

/**
 * Registered file types for the two Cosmoteer extensions. The [TextMateBackedFileType] marker is
 * the point: a plain file type would steal the files from the TextMate plugin and kill the bundled
 * grammar's highlighting, while a TextMate-backed one stays replaceable, so the editor still opens
 * the files as TextMate. Registering them anyway is what gives the files an icon (through the
 * TextMate plugin's own icon provider) and stops the "Plugins supporting *.rules files found"
 * advertiser banner, which only fires for extensions no installed plugin claims.
 */
object CosmoteerIcons {
    val FILE: Icon = IconLoader.getIcon("/icons/fileIcon.png", CosmoteerIcons::class.java)
}

object RulesFileType : FileType, TextMateBackedFileType {
    override fun getName(): String = "Cosmoteer Rules"
    override fun getDescription(): String = "Cosmoteer rules file"
    override fun getDefaultExtension(): String = "rules"
    override fun getIcon(): Icon = CosmoteerIcons.FILE
    override fun isBinary(): Boolean = false
    override fun isReadOnly(): Boolean = false
}

object ShaderFileType : FileType, TextMateBackedFileType {
    override fun getName(): String = "Cosmoteer Shader"
    override fun getDescription(): String = "Cosmoteer shader file"
    override fun getDefaultExtension(): String = "shader"
    override fun getIcon(): Icon = CosmoteerIcons.FILE
    override fun isBinary(): Boolean = false
    override fun isReadOnly(): Boolean = false
}
