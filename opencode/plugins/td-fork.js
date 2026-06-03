import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export default async ({ directory }) => {
  const stateDir = join(process.env.XDG_RUNTIME_DIR || "/tmp", "td-opencode-session")
  const stateFile = join(stateDir, createHash("sha256").update(directory).digest("hex"))

  const rememberSession = (sessionID) => {
    if (!sessionID) return
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(stateFile, `${sessionID}\n${directory}\n`, "utf8")
  }

  return {
    event: async ({ event }) => {
      rememberSession(event.properties?.sessionID)
    },
    "command.execute.before": async (input, output) => {
      rememberSession(input.sessionID)

      if (input.command !== "fork") return

      const child = spawn("td-opencode-fork", [input.sessionID], {
        cwd: directory,
        detached: true,
        stdio: "ignore",
      })
      child.unref()

      output.parts = []
    },
    "shell.env": async (input, output) => {
      if (!input.sessionID) return
      output.env.OPENCODE_SESSION_ID = input.sessionID
    },
  }
}
