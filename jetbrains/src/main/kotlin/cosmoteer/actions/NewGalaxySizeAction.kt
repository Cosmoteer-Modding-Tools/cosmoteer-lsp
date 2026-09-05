package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.JComponent

/**
 * Creates a galaxy size: a name and a number of systems. The server clones the game's standard map
 * generator with that count and offers the size to the career and creative modes. Mirrors the VS
 * Code `cosmoteer.newGalaxySize.create` command.
 */
class NewGalaxySizeAction : CreationWizardAction("cosmoteer.newGalaxySize", "Cosmoteer galaxy size") {
    override fun onScan(project: Project, anchor: String, scan: JsonObject) {
        val taken = (scan.getAsJsonArray("takenIds") ?: JsonArray()).map { it.asString.lowercase() }.toSet()
        val standard = scan.get("standardSystems")?.takeIf { !it.isJsonNull }?.asInt ?: 75
        val dialog = NewGalaxySizeDialog(project, taken, standard)
        if (!dialog.showAndGet()) return
        write(project, anchor, dialog.args()) { answer ->
            val notes = mutableListOf("Created the galaxy size ${answer.get("id")?.asString}, offered when a new game begins.")
            notes += wiringNotes(answer)
            if ((answer.getAsJsonArray("localizationFiles")?.size() ?: 0) == 0) {
                notes += "This mod ships no language file, so its name and tip were not declared anywhere."
            }
            notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
            openCreatedFile(project, answer.get("file")?.asString)
        }
    }
}

/**
 * The galaxy size form: id, name and the number of systems.
 *
 * @param project the project the dialog belongs to.
 * @param takenIds the ids already in use, lower-cased.
 * @param standard how many systems the game's standard galaxy holds.
 */
private class NewGalaxySizeDialog(project: Project, private val takenIds: Set<String>, private val standard: Int) : DialogWrapper(project) {
    private val idField = JBTextField()
    private val nameField = JBTextField()
    private val systemsField = JBTextField((standard * 2).toString())

    init {
        title = "Cosmoteer: New Galaxy Size"
        setOKButtonText("Create Galaxy Size")
        setResizable(false)
        suggestNameFromId(idField, nameField)
        init()
    }

    override fun createCenterPanel(): JComponent {
        for (field in listOf(idField, nameField, systemsField)) field.preferredSize = Dimension(JBUI.scale(FIELD_WIDTH), field.preferredSize.height)
        val facts = JBLabel(
            "<html><body style='width: ${JBUI.scale(FIELD_WIDTH)}px'>" +
                "The game's standard generator is cloned with that count and the size is offered when a new " +
                "career or creative game begins. The standard galaxy holds $standard systems. Its name and " +
                "its tip become keys in the language files.</body></html>"
        )
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Size id:", idField, true)
            .addTooltip("One word: letters, digits and underscores. Huge, Tiny, Sprawling.")
            .addLabeledComponent("Display name:", nameField, true)
            .addLabeledComponent("Solar systems:", systemsField, true)
            .addVerticalGap(JBUI.scale(8))
            .addComponent(facts)
            .panel
    }

    override fun getPreferredFocusedComponent(): JComponent = idField

    override fun doValidate(): ValidationInfo? {
        val id = idField.text.trim()
        if (!BARE_ID.matches(id)) return ValidationInfo("One word: letters, digits and underscores, starting with a letter.", idField)
        if (takenIds.contains(id.lowercase())) return ValidationInfo("A galaxy size of that id already exists.", idField)
        if (nameField.text.isBlank()) return ValidationInfo("Give it a name.", nameField)
        val systems = systemsField.text.trim().toIntOrNull()
        if (systems == null || systems < 1) return ValidationInfo("A whole number of systems from 1 up.", systemsField)
        return null
    }

    /** The arguments the apply round takes, without the uri. */
    fun args(): JsonObject = JsonObject().apply {
        addProperty("id", idField.text.trim())
        addProperty("name", nameField.text.trim())
        addProperty("systems", systemsField.text.trim().toInt())
    }
}
