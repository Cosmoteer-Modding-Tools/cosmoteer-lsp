package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.CheckBoxList
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/** The cost the form starts with, the price of a mid-tree vanilla tech. */
private const val DEFAULT_COST = 3000

/**
 * Creates a tech: a part of the mod, a cost and the techs it builds on. The server writes the tech
 * with the part's own name, description, icon and group read by reference, and adds it to the
 * game's tech tree from the manifest. Mirrors the VS Code `cosmoteer.newTech.create` command.
 */
class NewTechAction : CreationWizardAction("cosmoteer.newTech", "Cosmoteer tech") {
    override fun onScan(project: Project, anchor: String, scan: JsonObject) {
        val parts = (scan.getAsJsonArray("parts") ?: JsonArray()).map { it.asJsonObject }
        val techs = (scan.getAsJsonArray("techs") ?: JsonArray()).map { it.asJsonObject }
        val dialog = NewTechDialog(project, parts, techs)
        if (!dialog.showAndGet()) return
        write(project, anchor, dialog.args()) { answer ->
            val notes = mutableListOf(
                "Created the tech ${answer.get("id")?.asString}. The part is now bought at a station before it can be built."
            )
            notes += wiringNotes(answer)
            notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
            openCreatedFile(project, answer.get("file")?.asString)
        }
    }

    /**
     * Why nothing was created: the two refusals this wizard has of its own, else the shared ones.
     *
     * @param failure the server's reason.
     * @return the message.
     */
    override fun failureMessage(failure: String): String = when (failure) {
        "noParts" -> "This mod declares no part, and a tech is written for a part. Create a part first."
        "unknownPart" -> "The mod declares no part of that id, so nothing was created."
        else -> creationFailureMessage(failure)
    }
}

/** One tech the picker offers, shown by name when the language files give one. */
private data class TechChoice(val id: String, val text: String) {
    override fun toString(): String = text
}

/**
 * The tech form: the part to unlock, the cost and the prerequisite checklist with a filter.
 *
 * @param project the project the dialog belongs to.
 * @param parts the mod's parts, each with its id, name and group field.
 * @param techs the game's techs and the mod's own, each with its id and name.
 */
private class NewTechDialog(
    project: Project,
    private val parts: List<JsonObject>,
    techs: List<JsonObject>,
) : DialogWrapper(project) {
    private val partField = ComboBox(parts.map { partLabel(it) }.toTypedArray())
    private val costField = JBTextField(DEFAULT_COST.toString())
    private val filterField = JBTextField()
    private val techList = CheckBoxList<TechChoice>()
    private val choices = techs.map { tech ->
        val id = tech.get("id")?.asString.orEmpty()
        val name = tech.get("name")?.takeIf { !it.isJsonNull }?.asString
        TechChoice(id, if (name != null) "$name ($id)" else id)
    }
    private val chosen = linkedSetOf<String>()

    init {
        title = "Cosmoteer: New Tech"
        setOKButtonText("Create Tech")
        setResizable(false)
        filterField.emptyText.text = "Filter the techs"
        filterField.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent) = showChoices()
            override fun removeUpdate(e: DocumentEvent) = showChoices()
            override fun changedUpdate(e: DocumentEvent) = showChoices()
        })
        techList.setCheckBoxListListener { index, value ->
            val choice = techList.getItemAt(index) ?: return@setCheckBoxListListener
            if (value) chosen += choice.id else chosen -= choice.id
        }
        showChoices()
        init()
    }

    /**
     * Fills the list with the techs matching the filter, keeping a chosen tech visible whatever the
     * filter says so a choice is never hidden from the author who made it.
     */
    private fun showChoices() {
        val needle = filterField.text.trim().lowercase()
        techList.clear()
        for (choice in choices) {
            if (needle.isEmpty() || choice.text.lowercase().contains(needle) || chosen.contains(choice.id)) {
                techList.addItem(choice, choice.text, chosen.contains(choice.id))
            }
        }
    }

    /**
     * One line of the part picker: the name when the language files give one, the id otherwise,
     * and the group field the tech will mirror.
     *
     * @param part the part the server reported.
     * @return the option's text.
     */
    private fun partLabel(part: JsonObject): String {
        val id = part.get("id")?.asString.orEmpty()
        val name = part.get("name")?.takeIf { !it.isJsonNull }?.asString
        val shown = if (name != null) "$name ($id)" else id
        return when (part.get("groupField")?.asString) {
            "EditorGroups" -> "$shown, in several toolbar groups"
            "none" -> "$shown, in no toolbar group"
            else -> shown
        }
    }

    override fun createCenterPanel(): JComponent {
        for (field in listOf(partField, costField, filterField)) field.preferredSize = Dimension(JBUI.scale(FIELD_WIDTH), field.preferredSize.height)
        val scroller = JBScrollPane(techList).apply { preferredSize = Dimension(JBUI.scale(FIELD_WIDTH), JBUI.scale(180)) }
        val facts = JBLabel(
            "<html><body style='width: ${JBUI.scale(FIELD_WIDTH)}px'>" +
                "Until a tech names it, the part is buildable from the start of a career. The tech takes its " +
                "name, description, icon and toolbar group from the part, is written under techs/ and is added " +
                "to the game's tech tree with an action in mod.rules.</body></html>"
        )
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Part to unlock:", partField, true)
            .addLabeledComponent("Cost:", costField, true)
            .addTooltip("Before the station's reputation factor. The game's mid-tree techs cost $DEFAULT_COST.")
            .addLabeledComponent("Prerequisites:", filterField, true)
            .addComponent(scroller)
            .addVerticalGap(JBUI.scale(8))
            .addComponent(facts)
            .panel
    }

    override fun getPreferredFocusedComponent(): JComponent = partField

    override fun doValidate(): ValidationInfo? {
        if (parts.isEmpty() || partField.selectedIndex < 0) return ValidationInfo("Pick a part.", partField)
        val cost = costField.text.trim().toIntOrNull()
        if (cost == null || cost < 1) return ValidationInfo("A whole number above zero.", costField)
        return null
    }

    /** The arguments the apply round takes, without the uri. */
    fun args(): JsonObject = JsonObject().apply {
        addProperty("part", parts[partField.selectedIndex].get("id")?.asString.orEmpty())
        addProperty("cost", costField.text.trim().toInt())
        add("prerequisites", JsonArray().apply { chosen.forEach { add(it) } })
    }
}
