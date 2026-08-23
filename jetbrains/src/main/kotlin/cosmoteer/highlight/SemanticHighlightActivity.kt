package cosmoteer.highlight

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * Creates the semantic highlighting service on project open and hands it the editors that are
 * already there. A project service is only created when something first asks for it, and nothing
 * else asks, so without this the overlay would start with the next editor the user opens and skip
 * the files restored with the project.
 */
class SemanticHighlightActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        CosmoteerSemanticHighlightService.getInstance(project).attachOpenEditors()
    }
}
