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
import com.intellij.ui.components.JBRadioButton
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.ButtonGroup
import javax.swing.JComponent
import javax.swing.JPanel

/** The sizes in the game's order, each with its caption. */
private val SIZES = listOf("s" to "S", "m" to "M", "l" to "L", "xl" to "XL", "xxl" to "XXL")

/** The sizes the rare and sun lists place. */
private val LARGE_SIZES = setOf("l", "xl", "xxl")

/**
 * Creates an asteroid type: a resource the deposits yield, a look borrowed from one of the game's
 * own deposits and a say in how rare and how big it is, in the two rounds the server's command
 * speaks. Mirrors the VS Code `cosmoteer.newAsteroidType.create` command.
 */
class NewAsteroidTypeAction : CreationWizardAction("cosmoteer.newAsteroidType", "Cosmoteer asteroid type") {
    override fun onScan(project: Project, anchor: String, scan: JsonObject) {
        val resources = (scan.getAsJsonArray("resources") ?: JsonArray()).map { it.asJsonObject }
        val looks = (scan.getAsJsonArray("looks") ?: JsonArray()).map { it.asJsonObject }
        if (resources.isEmpty() || looks.isEmpty()) {
            notify(
                project,
                "The game's resources and asteroid deposits could not be read, so there is nothing to build on.",
                NotificationType.WARNING,
            )
            return
        }
        val prefix = scan.get("authorPrefix")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
        if (prefix.isEmpty()) {
            notify(project, failureMessage("noAuthorPrefix"), NotificationType.WARNING)
            return
        }
        val taken = (scan.getAsJsonArray("takenIds") ?: JsonArray()).map { it.asString.lowercase() }.toSet()
        val dialog = NewAsteroidTypeDialog(project, prefix, resources, looks, taken)
        if (!dialog.showAndGet()) return
        write(project, anchor, dialog.args()) { answer ->
            val notes = mutableListOf("Created the asteroid type ${answer.get("id")?.asString}, spawning in career sectors from now on.")
            notes += asteroidWiringNotes(answer)
            if ((answer.getAsJsonArray("localizationFiles")?.size() ?: 0) == 0) {
                notes += "This mod ships no language file, so the names of its asteroids and deposits were not declared anywhere."
            }
            notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
            val files = (answer.getAsJsonArray("files") ?: JsonArray()).map { it.asString }
            openCreatedFile(project, files.firstOrNull { it.contains("doodad_asteroid_") } ?: files.firstOrNull())
        }
    }

    /** Why nothing was created: the shared failures, plus the one only an asteroid type can meet. */
    override fun failureMessage(failure: String): String = when (failure) {
        "noAuthorPrefix" ->
            "The manifest's ID has no author prefix (author.mod_name), which every asteroid and deposit id is built from."
        else -> creationFailureMessage(failure)
    }

    /**
     * Sentences about the wirings that did not happen. The shared notes read `present` for a
     * wiring that was already there, which this command reports as `alreadyThere`, so the
     * outcomes are mapped rather than the notes duplicated.
     *
     * @param answer the apply result.
     * @return the sentences, empty when everything was wired.
     */
    private fun asteroidWiringNotes(answer: JsonObject): List<String> {
        val wiring = answer.getAsJsonObject("wiring") ?: return emptyList()
        val mapped = JsonObject()
        for ((key, value) in wiring.entrySet()) {
            mapped.addProperty(key, if (value.asString == "alreadyThere") "present" else value.asString)
        }
        val copy = JsonObject().apply {
            add("wiring", mapped)
            answer.get("manifests")?.let { add("manifests", it) }
        }
        return wiringNotes(copy)
    }
}

/**
 * The asteroid type form: id, name, the resource, the look, the rarity, the sizes, the weight, the
 * hard tiles and the density.
 *
 * @param project the project the dialog belongs to.
 * @param prefix the author prefix every id is built with.
 * @param resources the resources the deposits can yield, each with its id and maybe a name.
 * @param looks the game's own deposits whose textures can be borrowed, each with its id and label.
 * @param takenIds the type ids already in use, lower-cased.
 */
private class NewAsteroidTypeDialog(
    project: Project,
    private val prefix: String,
    private val resources: List<JsonObject>,
    private val looks: List<JsonObject>,
    private val takenIds: Set<String>,
) : DialogWrapper(project) {
    private val idField = JBTextField()
    private val nameField = JBTextField()
    private val resourceIds = resources.map { it.get("id").asString }
    private val resourceBox = ComboBox(
        resources.map { resource ->
            val id = resource.get("id").asString
            val name = resource.get("name")?.takeIf { !it.isJsonNull }?.asString
            if (name != null) "$name ($id)" else id
        }.toTypedArray()
    )
    private val lookIds = looks.map { it.get("id").asString }
    private val lookBox = ComboBox(looks.map { it.get("label").asString }.toTypedArray())
    private val commonButton = JBRadioButton("Common, in the belts and fields like iron", true)
    private val rareButton = JBRadioButton("Rare, a valuable find marked on the map like uranium")
    private val sunButton = JBRadioButton("Sun, inside the damage zone of a sun")
    private val sizeBoxes = SIZES.map { (id, caption) -> id to JBCheckBox(caption, true) }
    private val weightField = JBTextField("1")
    private val densityField = JBTextField("")
    private val hardBox = JBCheckBox("Hard tiles towards the middle, needing a mining laser", true)
    private var lookTouched = false
    private var sizesTouched = false

    init {
        title = "Cosmoteer: New Asteroid Type"
        setOKButtonText("Create Asteroid Type")
        setResizable(false)
        resourceBox.selectedIndex = 0
        lookBox.selectedIndex = 0
        followResource()
        ButtonGroup().apply { add(commonButton); add(rareButton); add(sunButton) }
        resourceBox.addActionListener { followResource() }
        lookBox.addActionListener { if (lookBox.hasFocus()) lookTouched = true }
        for (button in listOf(commonButton, rareButton, sunButton)) button.addActionListener { followRarity() }
        for ((_, box) in sizeBoxes) box.addActionListener { sizesTouched = true }
        suggestNameFromId(idField, nameField)
        init()
    }

    /** Sets the look to the chosen resource's own deposit, when the game has one and the author has not chosen otherwise. */
    private fun followResource() {
        if (lookTouched) return
        val wanted = resourceIds.getOrNull(resourceBox.selectedIndex)?.lowercase() ?: return
        val index = lookIds.indexOfFirst { it.lowercase() == wanted }
        if (index >= 0) lookBox.selectedIndex = index
    }

    /** Sets the sizes to the ones the chosen rarity's list places, unless the author has chosen otherwise. */
    private fun followRarity() {
        if (sizesTouched) return
        val large = !commonButton.isSelected
        for ((id, box) in sizeBoxes) box.isSelected = !large || id in LARGE_SIZES
    }

    override fun createCenterPanel(): JComponent {
        for (field in listOf(idField, nameField)) field.preferredSize = Dimension(JBUI.scale(FIELD_WIDTH), field.preferredSize.height)
        val rarityPanel = JPanel().apply {
            layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS)
            add(commonButton)
            add(rareButton)
            add(sunButton)
        }
        val sizeRow = JPanel().apply { for ((_, box) in sizeBoxes) add(box) }
        val facts = JBLabel(
            "<html><body style='width: ${JBUI.scale(FIELD_WIDTH)}px'>" +
                "Every asteroid and deposit id is built around the type id, as $prefix.asteroid_&lt;id&gt;_s. " +
                "The look is one of the game's own deposits, whose textures and palette icons are borrowed until " +
                "you draw your own. The rare and sun lists only place the large sizes. The weight is a factor " +
                "on the game's own spawn weights, relative rather than a percentage. The names of its asteroids " +
                "and deposits become keys in the language files, with a placeholder to rewrite.</body></html>"
        )
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Asteroid type id:", idField, true)
            .addLabeledComponent("Display name:", nameField, true)
            .addLabeledComponent("Resource:", resourceBox, true)
            .addLabeledComponent("Look:", lookBox, true)
            .addLabeledComponent("Rarity:", rarityPanel, true)
            .addLabeledComponent("Sizes:", sizeRow, true)
            .addLabeledComponent("Weight:", weightField, true)
            .addLabeledComponent("Deposit density (empty for the resource's own):", densityField, true)
            .addComponent(hardBox)
            .addVerticalGap(JBUI.scale(8))
            .addComponent(facts)
            .panel
    }

    override fun getPreferredFocusedComponent(): JComponent = idField

    override fun doValidate(): ValidationInfo? {
        val id = idField.text.trim()
        if (!BARE_ID.matches(id)) return ValidationInfo("One word: letters, digits and underscores, starting with a letter.", idField)
        if (takenIds.contains(id.lowercase())) return ValidationInfo("An asteroid type of that id already exists.", idField)
        if (nameField.text.isBlank()) return ValidationInfo("Give it a name.", nameField)
        if (sizeBoxes.none { (_, box) -> box.isSelected }) return ValidationInfo("Pick at least one size.", sizeBoxes.first().second)
        val weight = weightField.text.trim().toDoubleOrNull()
        if (weight == null || weight <= 0) return ValidationInfo("The weight must be a number above zero.", weightField)
        val density = densityField.text.trim()
        if (density.isNotEmpty() && (density.toDoubleOrNull() ?: 0.0) <= 0) {
            return ValidationInfo("The density must be a number above zero, or empty.", densityField)
        }
        return null
    }

    /** The arguments the apply round takes, without the uri. */
    fun args(): JsonObject = JsonObject().apply {
        addProperty("id", idField.text.trim())
        addProperty("name", nameField.text.trim())
        addProperty("resource", resourceIds[resourceBox.selectedIndex])
        addProperty("look", lookIds[lookBox.selectedIndex])
        addProperty("rarity", if (rareButton.isSelected) "rare" else if (sunButton.isSelected) "sun" else "common")
        add("sizes", JsonArray().apply { for ((id, box) in sizeBoxes) if (box.isSelected) add(id) })
        addProperty("weight", weightField.text.trim().toDouble())
        addProperty("hard", hardBox.isSelected)
        densityField.text.trim().toDoubleOrNull()?.let { addProperty("density", it) }
    }
}
