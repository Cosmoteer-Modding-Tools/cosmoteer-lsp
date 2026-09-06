package cosmoteer.actions

import com.intellij.ui.components.JBTextField
import javax.swing.SwingUtilities
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/** How wide the fields of the creation forms run. */
const val FIELD_WIDTH = 420

/** An id as the game accepts one: a bare word. */
val BARE_ID = Regex("^[A-Za-z][A-Za-z0-9_]*$")

/**
 * Fills a form's name field from its id field, in words, until the author types a name of their own.
 *
 * @param idField the id the name is read from.
 * @param nameField the name field the suggestion is written into.
 */
fun suggestNameFromId(idField: JBTextField, nameField: JBTextField) {
    var touched = false

    fun suggest() {
        if (touched) return
        val suggested = idField.text.trim().split('_').filter { it.isNotEmpty() }
            .joinToString(" ") { it.replaceFirstChar { c -> c.uppercase() } }
        // Set later, since a document must not be written from inside its own change listener.
        SwingUtilities.invokeLater { if (!touched && nameField.text != suggested) nameField.text = suggested }
    }

    fun noteTouched() {
        if (nameField.hasFocus()) touched = nameField.text.isNotBlank()
    }

    idField.document.addDocumentListener(object : DocumentListener {
        override fun insertUpdate(e: DocumentEvent) = suggest()
        override fun removeUpdate(e: DocumentEvent) = suggest()
        override fun changedUpdate(e: DocumentEvent) = suggest()
    })
    nameField.document.addDocumentListener(object : DocumentListener {
        override fun insertUpdate(e: DocumentEvent) = noteTouched()
        override fun removeUpdate(e: DocumentEvent) = noteTouched()
        override fun changedUpdate(e: DocumentEvent) = noteTouched()
    })
}
