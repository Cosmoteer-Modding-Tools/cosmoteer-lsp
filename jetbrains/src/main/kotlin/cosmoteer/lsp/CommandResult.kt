package cosmoteer.lsp

import com.google.gson.Gson
import com.google.gson.JsonObject

private val gson = Gson()

/**
 * Reads a `workspace/executeCommand` answer as a JSON object.
 *
 * What comes back is typed `Any?`, and how it arrives is not ours to decide: depending on the LSP
 * client and how the result was deserialized it can already be a Gson tree, or a plain map, or a bean.
 * Casting straight to `JsonObject` therefore turns a perfectly good answer into null on some
 * versions, which reads downstream as "the server said nothing" and is indistinguishable from a real
 * failure. Converting instead handles every shape, and a Gson tree converts to itself.
 *
 * @param result the raw command result.
 * @returns the answer as an object, or null when the server really answered nothing.
 */
fun commandResultOf(result: Any?): JsonObject? {
    if (result == null) return null
    if (result is JsonObject) return result
    return try {
        gson.toJsonTree(result) as? JsonObject
    } catch (_: Exception) {
        null
    }
}
