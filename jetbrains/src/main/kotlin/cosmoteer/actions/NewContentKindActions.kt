package cosmoteer.actions

/**
 * The one-kind entries of the Cosmoteer submenu under New: each creates one content kind without
 * asking which, so the menu reads the way an IDE's New menu reads, one line per thing to make. The
 * generic `NewContentAction` stays for the palette, where asking is the point.
 */
class NewPartAction : NewContentAction("part")

class NewResourceAction : NewContentAction("resource")

class NewShotAction : NewContentAction("bullet")

class NewMediaEffectAction : NewContentAction("mediaEffect")

class NewLogoShipAction : NewContentAction("logoShip")

class NewDecalFolderAction : NewContentAction("decalFolder")

class NewEditorGroupAction : NewContentAction("editorGroup")

class NewPartStatAction : NewContentAction("partStat")

class NewPartToggleAction : NewContentAction("partToggle")

class NewBuffAction : NewContentAction("buff")

class NewCodexPageAction : NewContentAction("codexPage")
