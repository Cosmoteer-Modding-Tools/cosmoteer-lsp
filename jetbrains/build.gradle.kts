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
version = "0.5.0"

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
    // Implementing a Java interface with default methods (ToolWindowFactory) makes Kotlin emit a
    // synthetic override stub for every inherited default method. The plugin verifier reads those
    // stubs as usages of deprecated/internal API (isApplicable, getAnchor, manage and so on).
    // -jvm-default=no-compatibility relies on JVM default-method dispatch and skips the
    // compatibility bridges, so no stubs are generated. (Plain -jvm-default=enable keeps those
    // bridges and the verifier still flags them.) The IntelliJ platform pins the Kotlin language
    // version below 2.2 for runtime compatibility, so this is set explicitly rather than inherited.
    compilerOptions {
        freeCompilerArgs.add("-jvm-default=no-compatibility")
    }
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
        // Fail on internal-API usage too: the marketplace rejects it, and now that the source is
        // clean (the ToolWindowFactory stubs are gone via -jvm-default=no-compatibility) this makes
        // any future internal-API creep, e.g. a churny plugin-lookup, break the build before upload.
        failureLevel = listOf(
            VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            VerifyPluginTask.FailureLevel.OVERRIDE_ONLY_API_USAGES,
            VerifyPluginTask.FailureLevel.INTERNAL_API_USAGES,
        )
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3.5")
            // Also verify against the latest stable: the marketplace checks a range up to the newest
            // EAP, and API internal/deprecated annotations shift between releases (the plugin-lookup
            // churn kept surfacing only on builds newer than the sinceBuild floor, e.g. getPlugins()
            // went internal in 262 but was clean in 252). EAP snapshot IDEs don't resolve through the
            // plugin's IDE-download coordinate, so the newest EAP is only checked by the marketplace
            // upload itself; keep anything platform-version-sensitive out of the code (see PluginPaths).
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2.6")
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
    from(File(repoRoot, "out/server/src/server.mjs")) {
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
