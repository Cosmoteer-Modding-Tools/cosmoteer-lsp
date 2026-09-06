package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.ColorPanel
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Dimension
import javax.swing.JComponent

/** The border colour a faction starts with, the same purple the server writes when none is named. */
private val DEFAULT_COLOR = Color(143, 48, 220)

/** A faction id as the game accepts one: a bare word, since ships and sectors write it unquoted. */
private val FACTION_ID = Regex("^[A-Za-z][A-Za-z0-9_]*$")

/**
 * What the dialog asked for.
 *
 * @param icon a PNG to copy in as the icon, or null for the game's own.
 * @param beaconShip a saved ship to copy in as the FTL beacon, or null for the game's own.
 * @param lore whether a lore page is written for the codex.
 */
class NewFactionForm(
    val id: String,
    val name: String,
    val color: Color,
    val icon: String?,
    val beaconShip: String?,
    val lore: Boolean,
)

/**
 * The form a new faction is described on: its id, the name the game shows, and the colour of its
 * border on the map, on one modal dialog. One dialog rather than a chain of input boxes, so that
 * nothing entered is lost between the questions and the answers can be corrected before any of
 * them is sent.
 *
 * @param project the project the dialog belongs to.
 * @param modName the folder name of the mod the faction is written into.
 * @param takenIds the ids already in use, lower-cased.
 * @param playerIndexes the player indexes the faction will get, military first.
 */
private class NewFactionDialog(
    project: Project,
    private val modName: String,
    private val takenIds: Set<String>,
    private val playerIndexes: Pair<Int, Int>,
) : DialogWrapper(project) {
    private val idField = JBTextField()
    private val nameField = JBTextField()
    private val colorPanel = ColorPanel()
    private val iconField = TextFieldWithBrowseButton()
    private val beaconField = TextFieldWithBrowseButton()
    private val loreBox = JBCheckBox("Write a lore page for the codex", true)

    init {
        title = "Cosmoteer: New Faction"
        setOKButtonText("Create Faction")
        setResizable(false)
        colorPanel.selectedColor = DEFAULT_COLOR
        iconField.addBrowseFolderListener(
            "Faction Icon",
            "A square PNG, copied into the faction folder.",
            project,
            FileChooserDescriptorFactory.createSingleFileDescriptor("png")
        )
        beaconField.addBrowseFolderListener(
            "FTL Beacon Ship",
            "The saved ship the beacon is built from, copied into the faction folder.",
            project,
            FileChooserDescriptorFactory.createSingleFileDescriptor("png")
        )
        suggestNameFromId(idField, nameField)
        init()
    }

    /**
     * Builds the dialog body: the three fields, then what the server will do with them.
     *
     * @returns the body component.
     */
    override fun createCenterPanel(): JComponent {
        for (field in listOf(idField, nameField)) {
            field.preferredSize = Dimension(JBUI.scale(FIELD_WIDTH), field.preferredSize.height)
        }
        val facts = JBLabel(
            "<html><body style='width: ${JBUI.scale(FIELD_WIDTH)}px'>" +
                "Written into the mod <b>$modName</b>.<br>" +
                "Player indexes ${playerIndexes.first} (military) and ${playerIndexes.second} (civilian), " +
                "the first free block above the game's own.<br>" +
                "The icon and the FTL beacon start as the game's own, named in the files for you to replace." +
                "</body></html>"
        )
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Faction id:", idField, true)
            .addTooltip("How ships and sectors name it. One word: letters, digits and underscores.")
            .addLabeledComponent("Display name:", nameField, true)
            .addTooltip("The name the game shows, written to every language file of the mod.")
            .addLabeledComponent("Border colour:", colorPanel, true)
            .addTooltip("The colour of its territory border on the galaxy map.")
            .addLabeledComponent("Icon:", iconField, true)
            .addTooltip("A square PNG, copied into the faction folder. Empty leaves the game's own in place.")
            .addLabeledComponent("FTL beacon ship:", beaconField, true)
            .addTooltip("The saved ship the beacon is built from, copied into the faction folder. Empty leaves the game's own in place.")
            .addComponent(loreBox)
            .addTooltip("A page under the codex lore tab with the icon and three paragraphs, each a key in the language files for you to fill.")
            .addVerticalGap(JBUI.scale(8))
            .addComponent(facts)
            .panel
    }

    /**
     * The control the caret lands on.
     *
     * @returns the id field.
     */
    override fun getPreferredFocusedComponent(): JComponent = idField

    /**
     * Checks the id and the name before the dialog accepts.
     *
     * @returns the first problem, or null when the form can be sent.
     */
    override fun doValidate(): ValidationInfo? {
        val id = idField.text.trim()
        if (!FACTION_ID.matches(id)) {
            return ValidationInfo("One word: letters, digits and underscores, starting with a letter.", idField)
        }
        if (takenIds.contains(id.lowercase())) return ValidationInfo("A faction of that id already exists.", idField)
        if (nameField.text.isBlank()) return ValidationInfo("Give it a name.", nameField)
        return null
    }

    /** What was entered, read after the dialog accepted. */
    val form: NewFactionForm
        get() = NewFactionForm(
            idField.text.trim(),
            nameField.text.trim(),
            colorPanel.selectedColor ?: DEFAULT_COLOR,
            iconField.text.trim().ifEmpty { null },
            beaconField.text.trim().ifEmpty { null },
            loreBox.isSelected,
        )
}

/**
 * Asks the author to describe a new faction.
 *
 * Must be called on the event dispatch thread, like every modal dialog.
 *
 * @param project the project the dialog belongs to.
 * @param modName the folder name of the mod the faction is written into.
 * @param takenIds the ids already in use, lower-cased.
 * @param playerIndexes the player indexes the faction will get, military first.
 * @returns what was entered, or null when the dialog was cancelled.
 */
fun askNewFaction(project: Project, modName: String, takenIds: Set<String>, playerIndexes: Pair<Int, Int>): NewFactionForm? {
    val dialog = NewFactionDialog(project, modName, takenIds, playerIndexes)
    return if (dialog.showAndGet()) dialog.form else null
}
