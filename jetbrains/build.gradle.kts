import org.jetbrains.changelog.Changelog
import org.jetbrains.changelog.ChangelogSectionUrlBuilder
import org.jetbrains.changelog.date

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform") version "2.1.0"
    id("org.jetbrains.changelog") version "2.2.1"
}

group = "modding.cosmoteer.tools"
version = "0.4"

repositories {
    intellijPlatform {
        defaultRepositories()
    }
    mavenCentral()
}

dependencies {
    intellijPlatform {
        instrumentationTools()
        pluginVerifier()
        zipSigner()
        bundledPlugin("JavaScript")
        bundledPlugin("org.jetbrains.plugins.textmate")
        intellijIdeaUltimate("2024.2.3")
    }
}

intellijPlatform {
    pluginConfiguration {
        id = "cosmoteer-language-server"
        name = "Cosmoteer Language Server"
        version = "0.4.0"
        description = "Cosmoteer Language Server provides a lot of useful features, like autocompletion and diagnostics."
        ideaVersion {
            sinceBuild = "242"
            untilBuild = "242.*"
        }
        tasks {
            prepareSandbox {
                doLast {
                    copy {
                        from("${project.projectDir}/../out/server/src/server.js")
                        into("${destinationDir.path}/cosmoteer-lsp/language-server/")
                    }
                    copy {
                        from("${project.projectDir}/../syntaxes/rules.tmLanguage")
                        into("${destinationDir.path}/cosmoteer-lsp/ressources/rules.tmBundle/Syntaxes/")
                    }
                    copy {
                        from("${project.projectDir}/rules.tmBundle")
                        into("${destinationDir.path}/cosmoteer-lsp/ressources/rules.tmBundle")
                    }
                }
            }
        }
        vendor {
            url = "https://github.com/Cosmoteer-Modding-Tools/cosmoteer-lsp"
            name = "Cosmoteer Modding Tools"
        }
    }
}

tasks {
    patchPluginXml {
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
}

changelog {
    version.set("0.4.0")
    path.set(file("CHANGELOG.md").canonicalPath)
    header.set(provider { "[${version.get()}] - ${date()}" })
    headerParserRegex.set("""(\d+\.\d+)""".toRegex())
    introduction.set(
        """
        Cosmoteer Language server provides a lot of useful features, like:
        
        - Autocompletion
        - Diagnostics
        """.trimIndent()
    )
    itemPrefix.set("-")
    keepUnreleasedSection.set(true)
    unreleasedTerm.set("[Unreleased]")
    groups.set(listOf("Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"))
    lineSeparator.set("\n")
    combinePreReleases.set(true)
    sectionUrlBuilder.set(ChangelogSectionUrlBuilder { repositoryUrl, currentVersion, previousVersion, isUnreleased -> "foo" })
}

rootProject.extensions.add("gradle.version", "8.5")

rootProject.extensions.add("kotlin.jvmTarget", "21")
rootProject.extensions.add("kotlin.freeCompilerArgs", listOf("-Xjvm-default=all"))

rootProject.extensions.add("java.sourceCompatibility", "21")
rootProject.extensions.add("java.targetCompatibility", "21")