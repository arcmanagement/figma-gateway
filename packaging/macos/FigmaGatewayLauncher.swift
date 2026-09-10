import Darwin
import Foundation

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Figma Gateway: \(message)\n".utf8))
    exit(1)
}

private func runningExecutable() -> URL {
    var size = UInt32(PATH_MAX)
    var buffer = [CChar](repeating: 0, count: Int(size))
    guard _NSGetExecutablePath(&buffer, &size) == 0 else {
        fail("could not resolve the launcher path")
    }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
}

let executable = runningExecutable()
let executableName = executable.lastPathComponent
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
let resources = contents.appendingPathComponent("Resources", isDirectory: true)
let node = resources.appendingPathComponent("runtime/bin/node")

let entrypoint: URL
var forwardedArguments = Array(CommandLine.arguments.dropFirst())
switch executableName {
case "figma-gateway-mcp":
    entrypoint = resources.appendingPathComponent("app/dist/server/index.js")
case "FigmaGateway":
    entrypoint = resources.appendingPathComponent("app/dist/cli/index.js")
    if forwardedArguments.isEmpty {
        forwardedArguments = ["daemon", "start"]
    }
default:
    entrypoint = resources.appendingPathComponent("app/dist/cli/index.js")
}

guard FileManager.default.isExecutableFile(atPath: node.path) else {
    fail("bundled Node.js runtime is missing")
}
guard FileManager.default.fileExists(atPath: entrypoint.path) else {
    fail("bundled entrypoint is missing")
}

let arguments = [node.path, entrypoint.path] + forwardedArguments
var cArguments = arguments.map { strdup($0) }
cArguments.append(nil)
defer { cArguments.compactMap { $0 }.forEach { free($0) } }

execv(node.path, &cArguments)
fail(String(cString: strerror(errno)))
