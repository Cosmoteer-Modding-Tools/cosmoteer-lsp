rootProject.name = "cosmoteer-lsp"


buildscript {
    repositories {
        mavenCentral()
        maven("https://cache-redirector.jetbrains.com/intellij-dependencies")
        maven("https://www.jetbrains.com/intellij-repository/snapshots")
        maven("https://packages.jetbrains.team/maven/p/grazi/grazie-platform-public")
        maven("https://download.jetbrains.com/teamcity-repository")
        maven("https://oss.sonatype.org/content/repositories/snapshots/")
        gradlePluginPortal()
    }

    pluginManagement {
        plugins {
            id("java")
            id("org.jetbrains.kotlin.jvm") version "2.1.0-Beta1"
        }
    }
}