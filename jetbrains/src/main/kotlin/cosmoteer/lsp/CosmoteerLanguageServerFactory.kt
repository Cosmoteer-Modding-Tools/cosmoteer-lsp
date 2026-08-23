package cosmoteer.lsp

import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.client.LanguageClientImpl
import com.redhat.devtools.lsp4ij.client.features.LSPClientFeatures
import com.redhat.devtools.lsp4ij.client.features.LSPSemanticTokensFeature
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider
import org.eclipse.lsp4j.services.LanguageServer

/** Wires the bundled Node language server into LSP4IJ. */
class CosmoteerLanguageServerFactory : LanguageServerFactory {
    override fun createConnectionProvider(project: Project): StreamConnectionProvider =
        CosmoteerConnectionProvider(project)

    override fun createLanguageClient(project: Project): LanguageClientImpl =
        CosmoteerLanguageClient(project)

    override fun getServerInterface(): Class<out LanguageServer> =
        CosmoteerLanguageServerAPI::class.java

    override fun createClientFeatures(): LSPClientFeatures =
        LSPClientFeatures().setSemanticTokensFeature(object : LSPSemanticTokensFeature() {
            // Off for good, not tied to the user's setting: the plugin paints the server's
            // semantic tokens itself in CosmoteerSemanticHighlightService, and both painters on
            // the same offsets would merge their attributes into something neither intended.
            // LSP4IJ's own highlight visitor is also what made the overlay flicker, because it
            // contributes nothing while a request is in flight and the daemon commits that empty
            // result as the file's semantic layer.
            override fun isEnabled(file: PsiFile): Boolean = false
        })
}
