package cosmoteer.lsp

import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import com.redhat.devtools.lsp4ij.LanguageServerFactory
import com.redhat.devtools.lsp4ij.client.LanguageClientImpl
import com.redhat.devtools.lsp4ij.client.features.LSPClientFeatures
import com.redhat.devtools.lsp4ij.client.features.LSPSemanticTokensFeature
import com.redhat.devtools.lsp4ij.server.StreamConnectionProvider
import cosmoteer.settings.CosmoteerSettings
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
            // The TextMate grammar already colors the whole file synchronously. The LSP token
            // overlay repaints asynchronously after every edit, which users see as flickering,
            // so it is opt-in (Settings | Tools | Cosmoteer Rules).
            override fun isEnabled(file: PsiFile): Boolean =
                CosmoteerSettings.getInstance().state.semanticTokensEnabled
        })
}
