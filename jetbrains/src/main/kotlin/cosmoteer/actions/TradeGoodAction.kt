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
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import javax.swing.JComponent

/** The rarities the server supports, in the server's words and the author's. */
private val RARITIES = listOf(
    "common" to "Common: weight 20, as iron and coils. Stations keep up to a tenth of their storage in it.",
    "uncommon" to "Uncommon: weight 10, as hyperium and copper. Stations keep up to a twentieth.",
    "rare" to "Rare: weight 5 and half a hold, as diamonds and gold. Stations keep only a trace.",
)

/**
 * Puts a resource into the career trade: two manifest actions that make trade ships carry it and
 * stations stock it, in the two rounds the server's command speaks. Mirrors the VS Code
 * `cosmoteer.tradeGood.create` command.
 */
class TradeGoodAction : CreationWizardAction("cosmoteer.tradeGood", "Cosmoteer trade", "nothing was written") {
    override fun onScan(project: Project, anchor: String, scan: JsonObject) {
        val offered = (scan.getAsJsonArray("resources") ?: JsonArray())
            .map { it.asJsonObject }
            .filter { it.get("stackable")?.asBoolean == true }
        if (offered.isEmpty()) {
            notify(project, "No resource that stacks is declared anywhere, so there is nothing to trade.", NotificationType.WARNING)
            return
        }
        val dialog = TradeGoodDialog(project, offered)
        if (!dialog.showAndGet()) return
        val args = dialog.args()
        val buying = args.get("stationsBuy")?.asBoolean == true
        write(project, anchor, args) { answer ->
            val resource = answer.get("resource")?.asString
            val notes = mutableListOf(
                if (buying) "Trade ships now carry $resource, and stations buy it."
                else "Trade ships now carry $resource, and stations stock it."
            )
            val wiring = answer.getAsJsonObject("wiring")
            if (wiring?.get("cargo")?.asString == "present" && wiring.get("stations")?.asString == "present") {
                notes += "The manifest already traded it, so nothing changed."
            }
            notes += wiringNotes(answer)
            notify(project, notes.joinToString(" "), NotificationType.INFORMATION)
            openCreatedFile(project, answer.get("manifest")?.asString?.takeIf { it.isNotEmpty() })
        }
    }

    /** Why nothing was written: the failures this wizard adds, else the ones the creation actions share. */
    override fun failureMessage(failure: String): String = when (failure) {
        "unknownResource" -> "No resource of that id is declared, so the trade cannot carry it."
        "notStackable" -> "That resource has no stack size, and the trade never carries one that does not stack."
        else -> creationFailureMessage(failure)
    }
}

/**
 * The trade form: the resource, how common it is, and whether stations buy it rather than stock it.
 *
 * @param project the project the dialog belongs to.
 * @param resources the resources that stack, each with its id, name, source and whether it is traded.
 */
private class TradeGoodDialog(
    project: Project,
    private val resources: List<JsonObject>,
) : DialogWrapper(project) {
    private val resourceBox = ComboBox(resources.map { caption(it) }.toTypedArray())
    private val rarityBox = ComboBox(RARITIES.map { it.second }.toTypedArray())
    private val buyBox = JBCheckBox("Stations buy it rather than sell it", false)

    init {
        title = "Cosmoteer: Resource in Trade"
        setOKButtonText("Put It in the Trade")
        setResizable(false)
        resourceBox.selectedIndex = 0
        rarityBox.selectedIndex = 1
        init()
    }

    /** The resource as the picker shows it: its name, id, where it comes from and whether it is traded already. */
    private fun caption(resource: JsonObject): String {
        val id = resource.get("id").asString
        val name = resource.get("name")?.takeIf { !it.isJsonNull }?.asString
        val source = if (resource.get("source")?.asString == "mod") "mod" else "game"
        val carried = resource.get("alreadyCarried")?.asBoolean == true
        val stocked = resource.get("alreadyStocked")?.asBoolean == true
        val traded = when {
            carried && stocked -> ", already traded"
            carried -> ", already carried"
            stocked -> ", already stocked"
            else -> ""
        }
        return if (name != null) "$name ($id, $source$traded)" else "$id ($source$traded)"
    }

    override fun createCenterPanel(): JComponent {
        val facts = JBLabel(
            "<html><body style='width: ${JBUI.scale(FIELD_WIDTH)}px'>" +
                "Your mod's resources first, then the game's own. A game resource the game does not trade can " +
                "be made tradeable here. Two manifest actions put it on every trade ship and in every station, " +
                "and no file is created. When stations buy it, they hold none of their own and pay for what you " +
                "bring, the way the game treats precious goods. The resource needs a buy price to be worth " +
                "anything at a station.</body></html>"
        )
        return FormBuilder.createFormBuilder()
            .addLabeledComponent("Resource:", resourceBox, true)
            .addLabeledComponent("How common it is:", rarityBox, true)
            .addComponent(buyBox)
            .addVerticalGap(JBUI.scale(8))
            .addComponent(facts)
            .panel
    }

    override fun getPreferredFocusedComponent(): JComponent = resourceBox

    override fun doValidate(): ValidationInfo? =
        if (resourceBox.selectedIndex < 0) ValidationInfo("Pick a resource.", resourceBox) else null

    /** The arguments the apply round takes, without the uri. */
    fun args(): JsonObject = JsonObject().apply {
        addProperty("resource", resources[resourceBox.selectedIndex].get("id").asString)
        addProperty("rarity", RARITIES[rarityBox.selectedIndex].first)
        addProperty("stationsBuy", buyBox.isSelected)
    }
}
