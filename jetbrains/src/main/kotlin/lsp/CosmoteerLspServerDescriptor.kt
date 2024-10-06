package lsp

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.javascript.nodejs.interpreter.NodeCommandLineConfigurator
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.javascript.nodejs.interpreter.wsl.WslNodeInterpreter
import com.intellij.lang.javascript.service.JSLanguageServiceUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import org.jetbrains.plugins.textmate.TextMateService
import org.jetbrains.plugins.textmate.configuration.TextMateUserBundlesSettings

class CosmoteerLspServerDescriptor(project: Project) : ProjectWideLspServerDescriptor(project, "Cosmoteer Language Server") {
    override fun isSupportedFile(file: VirtualFile): Boolean {
        return file.extension == "rules"
    }

    override fun createCommandLine(): GeneralCommandLine {
        val textMateBundle = JSLanguageServiceUtil.getPluginDirectory(javaClass, "ressources/rules.tmBundle")
        println(textMateBundle.exists())
        TextMateUserBundlesSettings.getInstance()?.addBundle(textMateBundle.path, "rules")
        TextMateService.getInstance().reloadEnabledBundles();
        // start language server
        val interpreter = NodeJsInterpreterManager.getInstance(project).interpreter
        if (interpreter !is NodeJsLocalInterpreter && interpreter !is WslNodeInterpreter) {
            throw ExecutionException("Interpreter not configured")
        }

        val lsp = JSLanguageServiceUtil.getPluginDirectory(javaClass, "language-server/server.js")
        if (lsp == null || !lsp.exists()) {
            // broken plugin installation?
            throw ExecutionException("Language server not found")
        }

        return GeneralCommandLine().apply {
            withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
            withCharset(Charsets.UTF_8)
            addParameter(lsp.path)
            addParameter("--stdio")
            NodeCommandLineConfigurator.find(interpreter)
                .configure(this, NodeCommandLineConfigurator.defaultOptions(project))
        }
    }


}