package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.ColorPanel
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Creates a nebula: a look inherited from one of the game's own, three colours of the author's and a
 * say in where it spawns, in the two rounds the server's command speaks. Mirrors the VS Code
 * `cosmoteer.newNebula.create` command.
 */
class NewNebulaAction : CreationWizardAction("cosmoteer.newNebula", "Cosmoteer nebula") {
    override fun onScan(project: Project, anchor: String, scan: JsonObject) {
        val bases = (scan.getAsJsonArray("bases") ?: JsonArray()).map { it.asJsonObject }
        if (bases.isEmpty()) {
            notify(project, "The game's nebulas could not be read, so there is no look to start from.", NotificationType.WARNING)
            return
        }
        val taken = (scan.getAsJsonArray("takenIds") ?: JsonArray()).map { it.asString.lowercase() }.toSet()
        val dialog = NewNebulaDialog(project, bases, taken)
        if (!dialog.showAndGet()) return
        write(project, anchor, dialog.args()) { answer ->
            val notes = mutableListOf("Created the nebula ${answer.get("id")?.asString}, spawning in career sectors from now on.")
            notes += wiringNotes(answer)
            if ((answer.getAsJsonArray("localizationFiles")?.size() ?: 0) == 0) {
                notes += "This mod ships no language file, so its tooltip and HUD text were not declared anywhere."
            }
            notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
            openCreatedFile(project, answer.get("nebulaFile")?.asString)
        }
    }
}

/**
 * The nebula form: id, name, the base look, three colours and the spawn settings.
 *
 * @param project the project the dialog belongs to.
 * @param bases the game's nebulas, each with its id and its three colours.
 * @param takenIds the ids already in use, lower-cased.
 */
private class NewNebulaDialog(
    project: Project,
    private val bases: List<JsonObject>,
    private val takenIds: Set<String>,
) : DialogWrapper(project) {
    private val idField = JBTextField()
    private val nameField = JBTextField()
    private val baseBox = ComboBox(bases.map { it.get("id").asString }.toTypedArray())
    private val colors = List(3) { ColorPanel() }
    private val radiusField = JBTextField("100000")
    private val countField = JBTextField("2")
    private val chanceField = JBTextField("100")
    private val nearField = JBTextField("10000")
    private val farField = JBTextField("25000")
    private val avoidBox = JBCheckBox("Keep it out of the starting sector", true)

    init {
        title = "Cosmoteer: New Nebula"
        setOKButtonText("Create Nebula")
        setResizable(false)
        baseBox.selectedIndex = 0
        applyBaseColors()
        baseBox.addActionListener { applyBaseColors() }
        suggestNameFromId(idField, nameField)
        init()
    }

    /** Sets the three colour pickers to the chosen base's own colours. */
    private fun applyBaseColors() {
        val base = bases.getOrNull(baseBox.selectedIndex) ?: return
        val list = base.getAsJsonArray("colors") ?: return
        for (i in 0 until 3) {
            val rgb = list.get(i).asJsonArray
            colors[i].selectedColor = Color(rgb.get(0).asInt, rgb.get(1).asInt, rgb.get(2).asInt)
        }
    }

    override fun createCenterPanel(): JComponent {
        for (field in listOf(idField, nameField)) field.preferredSize = Dimension(JBUI.scale(FIELD_WIDTH), field.preferredSize.height)
        val colorRow = JPanel().apply { colors.forEach { add(it) } }
        val facts = JBLabel(
            "<html><body style='width: ${JBUI.scale(FIELD_WIDTH)}px'>" +
                "The look is one of the game's own nebulas, inherited whole: its shaders, its effects on ships " +
                "and its sounds. The colours replace its own. The tooltip and HUD text become keys in the " +
                "language files, with a placeholder to rewrite.</body></html>"
        )
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Nebula id:", idField, true)
            .addLabeledComponent("Display name:", nameField, true)
            .addLabeledComponent("Look and behaviour:", baseBox, true)
            .addLabeledComponent("Colours:", colorRow, true)
            .addLabeledComponent("Radius (world units):", radiusField, true)
            .addLabeledComponent("At most per sector:", countField, true)
            .addLabeledComponent("Chance per sector (%):", chanceField, true)
            .addLabeledComponent("Nearest to the centre:", nearField, true)
            .addLabeledComponent("Farthest from the centre:", farField, true)
            .addComponent(avoidBox)
            .addVerticalGap(JBUI.scale(8))
            .addComponent(facts)
            .panel
    }

    override fun getPreferredFocusedComponent(): JComponent = idField

    override fun doValidate(): ValidationInfo? {
        val id = idField.text.trim()
        if (!BARE_ID.matches(id)) return ValidationInfo("One word: letters, digits and underscores, starting with a letter.", idField)
        if (takenIds.contains(id.lowercase())) return ValidationInfo("A nebula of that id already exists.", idField)
        if (nameField.text.isBlank()) return ValidationInfo("Give it a name.", nameField)
        for ((field, label) in listOf(radiusField to "radius", countField to "count", chanceField to "chance", nearField to "distance", farField to "distance")) {
            if (field.text.trim().toIntOrNull() == null) return ValidationInfo("A whole number for the $label.", field)
        }
        if (nearField.text.trim().toInt() > farField.text.trim().toInt()) return ValidationInfo("The nearest distance must not exceed the farthest.", nearField)
        return null
    }

    /** The arguments the apply round takes, without the uri. */
    fun args(): JsonObject = JsonObject().apply {
        addProperty("id", idField.text.trim())
        addProperty("name", nameField.text.trim())
        addProperty("base", baseBox.selectedItem as String)
        add("colors", JsonArray().apply {
            colors.forEach { panel ->
                val c = panel.selectedColor ?: Color.WHITE
                add(JsonArray().apply { add(c.red); add(c.green); add(c.blue) })
            }
        })
        addProperty("radius", radiusField.text.trim().toInt())
        add("count", JsonArray().apply { add(0); add(maxOf(1, countField.text.trim().toInt())) })
        add("distance", JsonArray().apply { add(nearField.text.trim().toInt()); add(farField.text.trim().toInt()) })
        addProperty("spawnChance", chanceField.text.trim().toInt().coerceIn(1, 100))
        addProperty("avoidStartingSector", avoidBox.isSelected)
    }
}
