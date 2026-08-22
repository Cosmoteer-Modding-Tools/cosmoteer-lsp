package cosmoteer.actions

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/** How wide the explanation above the picker is allowed to run before it wraps. */
private const val MESSAGE_WIDTH = 460

/** How wide the picker itself is allowed to run, so one long ship label cannot stretch the dialog. */
private const val CHOICE_WIDTH = 460

/**
 * A modal picker offering one of several choices, the shape every one of this plugin's pickers needs:
 * an explanation of what the choice means, a list to pick from, and an answer of which entry was
 * taken.
 *
 * The platform used to ship exactly this as `Messages.showChooseDialog`, which is deprecated and
 * scheduled for removal. The alternative the platform still offers, `Messages.showDialog`, renders
 * each choice as a button along the bottom of the dialog, which does not carry a list of every ship
 * class in the game. So the dialog is built here instead, with the same combo box the platform used.
 *
 * @param project the project the dialog belongs to.
 * @param message the explanation shown above the picker.
 * @param title the dialog title.
 * @param labels the choices, in the order they are offered.
 */
private class ChooseOneDialog(
    project: Project,
    private val message: String,
    title: String,
    private val labels: Array<String>,
) : DialogWrapper(project) {
    private val combo = ComboBox(labels)

    init {
        this.title = title
        setResizable(false)
        init()
    }

    /**
     * Builds the dialog body: the explanation, then the picker.
     *
     * @returns the body component.
     */
    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, JBUI.scale(8)))
        // Wrapped as HTML at a fixed width, because these explanations are full sentences and a plain
        // label would run the dialog off the screen.
        val text = JLabel("<html><body style='width: ${JBUI.scale(MESSAGE_WIDTH)}px'>$message</body></html>")
        panel.add(text, BorderLayout.NORTH)
        combo.preferredSize = Dimension(JBUI.scale(CHOICE_WIDTH), combo.preferredSize.height)
        if (labels.isNotEmpty()) combo.selectedIndex = 0
        panel.add(combo, BorderLayout.CENTER)
        return panel
    }

    /**
     * The control the caret lands on, so the choice can be made and accepted from the keyboard alone.
     *
     * @returns the picker.
     */
    override fun getPreferredFocusedComponent(): JComponent = combo

    /** The index of the chosen entry, or -1 when nothing was chosen. */
    val chosenIndex: Int
        get() = combo.selectedIndex
}

/**
 * Ask the author to pick one of `labels`.
 *
 * Must be called on the event dispatch thread, like every modal dialog. The answer matches what
 * `Messages.showChooseDialog` answered, so a caller can treat a negative result as "cancelled"
 * exactly as before.
 *
 * @param project the project the dialog belongs to.
 * @param message the explanation shown above the picker.
 * @param title the dialog title.
 * @param labels the choices, in the order they are offered.
 * @returns the index of the chosen entry, or -1 when the dialog was cancelled or there was nothing
 *  to choose from.
 */
fun chooseOne(project: Project, message: String, title: String, labels: Array<String>): Int {
    if (labels.isEmpty()) return -1
    val dialog = ChooseOneDialog(project, message, title, labels)
    return if (dialog.showAndGet()) dialog.chosenIndex else -1
}
