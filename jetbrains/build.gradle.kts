import org.jetbrains.changelog.Changelog
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform") version "2.17.0"
    id("org.jetbrains.changelog") version "2.2.1"
}

group = "modding.cosmoteer.tools"
version = "0.4.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Community baseline: the plugin runs on every JetBrains IDE (IDEA, Rider, PyCharm, ...)
        // because LSP4IJ replaces the Ultimate-only native LSP API.
        create("IC", "2024.3.5")
        plugins(listOf("com.redhat.devtools.lsp4ij:0.20.1"))
        bundledPlugin("org.jetbrains.plugins.textmate")
        pluginVerifier()
        zipSigner()
    }
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    // Skips the form/@NotNull bytecode instrumentation, which needs a deprecated tooling artifact.
    instrumentCode = false
    pluginConfiguration {
        id = "cosmoteer-language-server"
        name = "Cosmoteer Language Server"
        version = project.version.toString()
        description =
            "Language support for Cosmoteer .rules and .shader files: diagnostics, completion, hover, " +
            "navigation, rename, formatting, semantic highlighting, inlay hints, shader preview and more."
        ideaVersion {
            sinceBuild = "243"
            untilBuild = provider { null }
        }
        vendor {
            url = "https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp"
            name = "Cosmoteer Modding Tools"
        }
    }
    pluginVerification {
        // Same as the plugin's default fatal set, minus INTERNAL_API_USAGES: the only internal-API
        // hits are Kotlin's synthetic overrides of ToolWindowFactory's default methods
        // (getAnchor/getIcon/manage), which can't be removed from our source. Real compatibility
        // breaks and override-only violations still fail the build.
        failureLevel = listOf(
            VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            VerifyPluginTask.FailureLevel.OVERRIDE_ONLY_API_USAGES,
        )
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3.5")
            // Rider is the primary target audience (C# modders), verify against it explicitly.
            // Rider ships only as an installer, which the verifier can't unpack, so pull the
            // archive distribution instead (useInstaller = false). See plugin issue #1852.
            create(IntelliJPlatformType.Rider, "2024.3.5") {
                useInstaller = false
            }
        }
    }

    // Signing and publishing read every secret from the environment, so nothing sensitive lives in
    // the repo. Locally these env vars are unset and the signPlugin/publishPlugin tasks simply fail
    // if invoked; the normal build/verify tasks are unaffected. CI provides them per protected
    // environment (see .github/DEPLOYMENT.md).
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }
    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
        // A stable version (0.4.0) publishes to the default channel; a pre-release (0.4.0-eap.1)
        // publishes to a channel named after its qualifier (eap), keeping it off users' stable feed.
        val versionString = project.version.toString()
        channels = listOf(
            if ("-" in versionString) versionString.substringAfter('-').substringBefore('.') else "default"
        )
    }
}

// `gradlew runRider` opens a sandboxed Rider with the plugin, the default `runIde` uses IC.
val runRider = intellijPlatformTesting.runIde.register("runRider") {
    type = IntelliJPlatformType.Rider
    version = "2024.3.5"
    // Rider has no installer artifact the plugin can consume, use the archive distribution.
    useInstaller = false
}

// The plugin ships the esbuild server bundle plus the assets the Kotlin side reads at runtime.
// esbuild must have run at the repo root first (npm run compile); Gradle only stages files.
// withType covers every sandbox variant (buildPlugin, runIde, runRider, tests).
tasks.withType<PrepareSandboxTask>().configureEach {
    val repoRoot = project.projectDir.parentFile
    from(File(repoRoot, "out/server/src/server.js")) {
        into("${project.name}/language-server")
    }
    from(File(repoRoot, "l10n")) {
        into("${project.name}/l10n")
    }
    from(File(repoRoot, "media")) {
        into("${project.name}/media")
    }
    from(File(project.projectDir, "rules.tmBundle")) {
        into("${project.name}/textmate/rules.tmBundle")
    }
    from(File(repoRoot, "syntaxes/rules.tmLanguage")) {
        into("${project.name}/textmate/rules.tmBundle/Syntaxes")
    }
    from(File(repoRoot, "syntaxes/shader.tmLanguage.json")) {
        into("${project.name}/textmate/rules.tmBundle/Syntaxes")
    }
}

tasks.patchPluginXml {
    changeNotes.set(provider {
        changelog.renderItem(
            changelog
                .getUnreleased()
                .withHeader(false)
                .withEmptySections(false),
            Changelog.OutputType.HTML
        )
    })
}

changelog {
    version.set(project.version.toString())
    path.set(file("CHANGELOG.md").canonicalPath)
    keepUnreleasedSection.set(true)
    unreleasedTerm.set("[Unreleased]")
    groups.set(listOf("Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"))
}
