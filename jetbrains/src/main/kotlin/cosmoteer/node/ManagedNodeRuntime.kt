package cosmoteer.node

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.io.Decompressor
import com.intellij.util.io.HttpRequests
import com.intellij.util.system.CpuArch
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Downloads and manages a private Node.js runtime for the language server, so users without a
 * system-wide Node install need nothing but a click. The runtime is an official nodejs.org build,
 * pinned to one LTS version with its published SHA-256 per platform. Only the `node` executable
 * is kept. It lives under the IDE system directory and is shared by all projects.
 *
 * Bumping [VERSION] requires refreshing every checksum from
 * `https://nodejs.org/dist/v<version>/SHASUMS256.txt`.
 */
object ManagedNodeRuntime {
    private const val VERSION = "24.18.0"

    /** One downloadable artifact: the dist file name, its published SHA-256, and the archived executable path. */
    private class Artifact(val fileName: String, val sha256: String, val exeEntry: String)

    private val ARTIFACTS = mapOf(
        "win-x64" to Artifact(
            "node-v$VERSION-win-x64.zip",
            "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
            "node.exe"
        ),
        "win-arm64" to Artifact(
            "node-v$VERSION-win-arm64.zip",
            "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
            "node.exe"
        ),
        "darwin-x64" to Artifact(
            "node-v$VERSION-darwin-x64.tar.gz",
            "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
            "bin/node"
        ),
        "darwin-arm64" to Artifact(
            "node-v$VERSION-darwin-arm64.tar.gz",
            "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
            "bin/node"
        ),
        "linux-x64" to Artifact(
            "node-v$VERSION-linux-x64.tar.gz",
            "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
            "bin/node"
        ),
        "linux-arm64" to Artifact(
            "node-v$VERSION-linux-arm64.tar.gz",
            "6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508",
            "bin/node"
        ),
    )

    private val downloadRunning = AtomicBoolean(false)

    private fun platformKey(): String? {
        val os = when {
            SystemInfo.isWindows -> "win"
            SystemInfo.isMac -> "darwin"
            SystemInfo.isLinux -> "linux"
            else -> return null
        }
        val arch = when (CpuArch.CURRENT) {
            CpuArch.X86_64 -> "x64"
            CpuArch.ARM64 -> "arm64"
            else -> return null
        }
        return "$os-$arch"
    }

    private fun installDir(): Path =
        Paths.get(PathManager.getSystemPath(), "cosmoteer-node", "v$VERSION")

    /** The managed executable, or null when it has not been downloaded (or the platform has no build). */
    fun executable(): Path? {
        val artifact = ARTIFACTS[platformKey() ?: return null] ?: return null
        val exe = installDir().resolve(artifact.exeEntry.substringAfterLast('/'))
        return exe.takeIf { Files.isRegularFile(it) }
    }

    /** Whether a download could help on this machine (a build exists and is not yet installed). */
    fun isDownloadable(): Boolean = platformKey() != null && executable() == null

    /**
     * Downloads the runtime in a background task, verifying the pinned checksum before keeping
     * anything, then runs the callback (on the EDT) so the caller can start servers.
     *
     * @param project anchors the progress task and result notifications.
     * @param onReady invoked once the executable is in place. Not invoked on failure.
     */
    fun download(project: Project, onReady: Runnable) {
        val key = platformKey()
        val artifact = key?.let { ARTIFACTS[it] }
        if (artifact == null) {
            notify(project, "No Node.js build is available for this platform.", NotificationType.ERROR)
            return
        }
        if (!downloadRunning.compareAndSet(false, true)) return
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Downloading Node.js $VERSION", true) {
            override fun run(indicator: ProgressIndicator) {
                val url = "https://nodejs.org/dist/v$VERSION/${artifact.fileName}"
                val archive = Files.createTempFile("cosmoteer-node", "-${artifact.fileName}")
                try {
                    indicator.text = "Downloading ${artifact.fileName}"
                    HttpRequests.request(url).productNameAsUserAgent().saveToFile(archive.toFile(), indicator)
                    indicator.text = "Verifying checksum"
                    val actual = sha256Hex(archive)
                    check(actual.equals(artifact.sha256, ignoreCase = true)) {
                        "Checksum mismatch for $url: expected ${artifact.sha256}, got $actual"
                    }
                    indicator.text = "Extracting node"
                    val dir = installDir()
                    Files.createDirectories(dir)
                    // Only the node executable is extracted. npm and the rest of the dist stay out.
                    val topDir = artifact.fileName.removeSuffix(".zip").removeSuffix(".tar.gz")
                    val wanted = "$topDir/${artifact.exeEntry}"
                    val decompressor =
                        if (artifact.fileName.endsWith(".zip")) Decompressor.Zip(archive) else Decompressor.Tar(archive)
                    decompressor
                        .filter { entry -> entry.trimStart('/') == wanted }
                        .removePrefixPath("$topDir/${artifact.exeEntry.substringBeforeLast('/', "")}".trimEnd('/'))
                        .extract(dir)
                    val exe = dir.resolve(artifact.exeEntry.substringAfterLast('/'))
                    check(Files.isRegularFile(exe)) { "Extraction produced no executable at $exe" }
                    if (!SystemInfo.isWindows) exe.toFile().setExecutable(true)
                } finally {
                    Files.deleteIfExists(archive)
                }
            }

            override fun onSuccess() {
                notify(project, "Node.js $VERSION is ready, starting the Cosmoteer language server.", NotificationType.INFORMATION)
                onReady.run()
            }

            override fun onThrowable(error: Throwable) {
                logger<ManagedNodeRuntime>().warn("Node.js download failed", error)
                notify(
                    project,
                    "Downloading Node.js failed: ${error.message}. Install Node.js manually or set its path in Settings | Tools | Cosmoteer Rules.",
                    NotificationType.ERROR
                )
            }

            override fun onFinished() {
                downloadRunning.set(false)
            }
        })
    }

    private fun sha256Hex(file: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun notify(project: Project, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Cosmoteer Language Server")
            .createNotification("Cosmoteer language server", content, type)
            .notify(project)
    }
}
