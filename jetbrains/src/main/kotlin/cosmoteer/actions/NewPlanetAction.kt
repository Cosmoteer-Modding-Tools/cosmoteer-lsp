package cosmoteer.actions

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.JComponent

/** The bare word a planet id is built from. */
private val PLANET_WORD = Regex("^[A-Za-z][A-Za-z0-9_]*$")

/** The placements the server supports, in the server's words and the author's. */
private val PLACEMENTS = listOf(
    "inner" to "Inner planet, close to the sun",
    "outer" to "Outer planet, among the gas giants",
    "innerMoon" to "Moon of an inner planet",
    "outerMoon" to "Moon of an outer planet",
    "none" to "Not in career sectors, creative palette only",
)

/**
 * Creates a planet: a doodad built on one of the game's own planets, with a name, a size of the
 * author's and a say in where the career sectors place it, in the two rounds the server's command
 * speaks. Mirrors the VS Code `cosmoteer.newPlanet.create` command.
 */
class NewPlanetAction : CreationWizardAction("cosmoteer.newPlanet", "Cosmoteer planet") {
    override fun onScan(project: Project, anchor: String, scan: JsonObject) {
        val bases = (scan.getAsJsonArray("bases") ?: JsonArray()).map { it.asJsonObject }
        if (bases.isEmpty()) {
            notify(project, "The game's planets could not be read, so there is no look to start from.", NotificationType.WARNING)
            return
        }
        val prefix = scan.get("authorPrefix")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
        if (prefix.isEmpty()) {
            notify(project, failureMessage("noAuthorPrefix"), NotificationType.WARNING)
            return
        }
        val taken = (scan.getAsJsonArray("takenIds") ?: JsonArray()).map { it.asString.lowercase() }.toSet()
        val placements = (scan.getAsJsonArray("placements") ?: JsonArray()).map { it.asString }
        val dialog = NewPlanetDialog(project, bases, taken, prefix, placements)
        if (!dialog.showAndGet()) return
        write(project, anchor, dialog.args()) { answer ->
            val id = answer.get("id")?.asString
            val skipped = answer.getAsJsonObject("wiring")?.get("spawner")?.asString == "skipped"
            val notes = mutableListOf(
                if (skipped) "Created the planet $id, offered in the creative palette."
                else "Created the planet $id, spawning in career sectors from now on."
            )
            notes += wiringNotes(answer)
            if ((answer.getAsJsonArray("localizationFiles")?.size() ?: 0) == 0) {
                notes += "This mod ships no language file, so its name was not declared anywhere."
            }
            notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
            openCreatedFile(project, answer.get("file")?.asString)
        }
    }

    /** Why nothing was created: the failure this wizard adds, else the ones the creation actions share. */
    override fun failureMessage(failure: String): String = when (failure) {
        "noAuthorPrefix" ->
            "A planet id opens with the author segment of the mod id, and this mod's id has none. " +
                "Give the mod an id like author.mod first."
        else -> creationFailureMessage(failure)
    }
}

/**
 * The planet form: id, name, the base planet, where it spawns and how often, and the optional sizes.
 *
 * @param project the project the dialog belongs to.
 * @param bases the game's planets, each with its id, style, name and icon.
 * @param takenIds the doodad ids already in use, lower-cased.
 * @param prefix the author segment the doodad id opens with.
 * @param placements the placements the install's spawner can take.
 */
private class NewPlanetDialog(
    project: Project,
    private val bases: List<JsonObject>,
    private val takenIds: Set<String>,
    private val prefix: String,
    placements: List<String>,
) : DialogWrapper(project) {
    private val idField = JBTextField()
    private val nameField = JBTextField()
    private val baseBox = ComboBox(bases.map { baseCaption(it) }.toTypedArray())
    private val offered = PLACEMENTS.filter { placements.contains(it.first) }.ifEmpty { PLACEMENTS.takeLast(1) }
    private val placementBox = ComboBox(offered.map { it.second }.toTypedArray())
    private val weightField = JBTextField("1")
    private val resizeBox = JBCheckBox("Give it a size of its own", false)
    private val scaleMinField = JBTextField("250")
    private val scaleMaxField = JBTextField("1500")
    private val scaleDefaultField = JBTextField("1000")

    init {
        title = "Cosmoteer: New Planet"
        setOKButtonText("Create Planet")
        setResizable(false)
        baseBox.selectedIndex = 0
        placementBox.selectedIndex = 0
        applyResize()
        resizeBox.addActionListener { applyResize() }
        suggestNameFromId(idField, nameField)
        init()
    }

    /** The base as the picker shows it: the name when the language files declare one, the style and the id. */
    private fun baseCaption(base: JsonObject): String {
        val id = base.get("id").asString
        val style = base.get("style")?.asString.orEmpty()
        val label = base.get("label")?.takeIf { !it.isJsonNull }?.asString
        return if (label != null) "$label ($style style, $id)" else "$style style ($id)"
    }

    private fun applyResize() {
        for (field in listOf(scaleMinField, scaleMaxField, scaleDefaultField)) field.isEnabled = resizeBox.isSelected
    }

    override fun createCenterPanel(): JComponent {
        for (field in listOf(idField, nameField)) field.preferredSize = Dimension(JBUI.scale(FIELD_WIDTH), field.preferredSize.height)
        val facts = JBLabel(
            "<html><body style='width: ${JBUI.scale(FIELD_WIDTH)}px'>" +
                "The doodad id becomes $prefix.planet_&lt;id&gt;. The planet is one of the game's own, inherited " +
                "whole: its style, its sizes and its orbits. The icon is its own until you draw one. The name " +
                "becomes a key in the language files. Sizes are in world units: the game's rocky worlds span " +
                "250 to 1500, its gas giants 1000 to 3000.</body></html>"
        )
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Planet id:", idField, true)
            .addLabeledComponent("Display name:", nameField, true)
            .addLabeledComponent("Built on:", baseBox, true)
            .addLabeledComponent("Where it spawns:", placementBox, true)
            .addLabeledComponent("Chance weight:", weightField, true)
            .addComponent(resizeBox)
            .addLabeledComponent("Smallest:", scaleMinField, true)
            .addLabeledComponent("Largest:", scaleMaxField, true)
            .addLabeledComponent("Placed by hand at:", scaleDefaultField, true)
            .addVerticalGap(JBUI.scale(8))
            .addComponent(facts)
            .panel
    }

    override fun getPreferredFocusedComponent(): JComponent = idField

    override fun doValidate(): ValidationInfo? {
        val id = idField.text.trim()
        if (!PLANET_WORD.matches(id)) return ValidationInfo("One word: letters, digits and underscores, starting with a letter.", idField)
        if (takenIds.contains("$prefix.planet_${id.lowercase()}")) return ValidationInfo("A doodad of that id already exists.", idField)
        if (nameField.text.isBlank()) return ValidationInfo("Give it a name.", nameField)
        val weight = weightField.text.trim().toDoubleOrNull()
        if (weight == null || weight <= 0) return ValidationInfo("A number above zero for the weight.", weightField)
        if (resizeBox.isSelected) {
            val low = scaleMinField.text.trim().toDoubleOrNull()
            val high = scaleMaxField.text.trim().toDoubleOrNull()
            val at = scaleDefaultField.text.trim().toDoubleOrNull()
            if (low == null || low <= 0) return ValidationInfo("A number above zero for the smallest size.", scaleMinField)
            if (high == null || high < low) return ValidationInfo("The smallest size must not exceed the largest.", scaleMaxField)
            if (at == null || at < low || at > high) return ValidationInfo("The hand-placed size must lie between the two.", scaleDefaultField)
        }
        return null
    }

    /** The arguments the apply round takes, without the uri. */
    fun args(): JsonObject = JsonObject().apply {
        addProperty("id", idField.text.trim())
        addProperty("name", nameField.text.trim())
        addProperty("base", bases[baseBox.selectedIndex].get("id").asString)
        addProperty("placement", offered[placementBox.selectedIndex].first)
        addProperty("weight", weightField.text.trim().toDouble())
        if (resizeBox.isSelected) {
            add("scale", JsonArray().apply { add(scaleMinField.text.trim().toDouble()); add(scaleMaxField.text.trim().toDouble()) })
            addProperty("defaultScale", scaleDefaultField.text.trim().toDouble())
        }
    }
}
