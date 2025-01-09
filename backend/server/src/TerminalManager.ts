import Docker, { Container, Exec } from "dockerode"

/**
 * Manages pseudo-terminals (shell sessions) in a Docker container using `exec`.
 */
export class TerminalManager {
  private container: Container
  private terminals: Record<string, Exec> = {}
  // Optionally track the live input streams if you want to write without re-attaching
  // private streams: Record<string, NodeJS.WritableStream> = {}

  constructor(container: Container) {
    this.container = container
  }

  async createTerminal(
    id: string,
    onData: (output: string) => void
  ): Promise<void> {
    if (this.terminals[id]) {
      return
    }

    // Create an exec session
    const exec = await this.container.exec({
      Cmd: ["/bin/bash"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })

    // Start the exec
    const stream = await exec.start({ hijack: true, stdin: true })
    this.terminals[id] = exec

    // Handle output
    stream.on("data", (chunk: Buffer) => {
      onData(chunk.toString("utf-8"))
    })

    // Optionally run some initial commands
    const initialCommands = ["cd /home/user/project", "clear"]
    for (const cmd of initialCommands) {
      stream.write(cmd + "\r")
    }

    console.log("Created Docker terminal:", id)
  }

  async resizeTerminal(dimensions: { cols: number; rows: number }): Promise<void> {
    // Docker’s exec has a resize method
    for (const exec of Object.values(this.terminals)) {
      await exec.resize(dimensions)
    }
  }

  async sendTerminalData(id: string, data: string): Promise<void> {
    const exec = this.terminals[id]
    if (!exec) return

    // Re-attach to push data
    const stream = await exec.start({ hijack: true, stdin: true })
    stream.write(data)
  }

  async closeTerminal(id: string): Promise<void> {
    if (!this.terminals[id]) return
    // There's no forced kill for an exec session except by killing processes inside the container,
    // or writing `exit\r`. We'll just remove references.
    delete this.terminals[id]
  }

  async closeAllTerminals() {
    const ids = Object.keys(this.terminals)
    for (const id of ids) {
      await this.closeTerminal(id)
    }
  }
}
