import Docker, { Container, Exec } from "dockerode"

// A structure to store the exec object and the open stream
type TerminalSession = {
  exec: Docker.Exec,
  stream: NodeJS.Socket
}

export class TerminalManager {
  private container: Container
  // Instead of just storing Exec, store the entire session
  private terminals: Record<string, TerminalSession> = {}

  constructor(container: Container) {
    this.container = container
  }

  async createTerminal(
    id: string,
    onData: (output: string) => void
  ): Promise<void> {
    if (this.terminals[id]) {
      return // already created
    }

    const exec = await this.container.exec({
      Cmd: ["/bin/bash"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })

    const stream = await exec.start({ hijack: true, stdin: true })

    // Convert the Duplex stream to a raw NodeJS socket
    // Dockerode returns a multiplexed stream so you might need to demux or do the “modem.demuxStream” if you want separate stdout/stderr
    // But for now, let's assume the default merges them.
    stream.on("data", (chunk: Buffer) => {
      onData(chunk.toString("utf-8"))
    })

    // Store both the exec and the stream in memory
    this.terminals[id] = { exec, stream }

    // (Optional) run initial commands
    stream.write("cd /home/user/project\r")
    stream.write("clear\r")

    console.log("Created Docker terminal:", id)
  }

  async sendTerminalData(id: string, data: string): Promise<void> {
    const session = this.terminals[id]
    if (!session) {
      return
    }
    // Write data to the same stream
    session.stream.write(data)
  }

  async resizeTerminal(dimensions: { cols: number; rows: number }): Promise<void> {
    for (const { exec } of Object.values(this.terminals)) {
      await exec.resize(dimensions)
    }
  }

  async closeTerminal(id: string): Promise<void> {
    const session = this.terminals[id]
    if (!session) return
    // There's no direct "kill" of a Docker Exec except by killing the process in the container (e.g. `exit`).
    // We can write 'exit\r' or just remove references
    session.stream.write("exit\r")
    delete this.terminals[id]
  }

  async closeAllTerminals() {
    for (const id of Object.keys(this.terminals)) {
      await this.closeTerminal(id)
    }
  }
}
