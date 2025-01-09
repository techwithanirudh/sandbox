// /backend/server/src/TerminalManager.ts
import Docker, { Container, Exec } from "dockerode"
import logger from "./logger"

type TerminalSession = {
  exec: Docker.Exec
  stream: NodeJS.Socket
}

export class TerminalManager {
  private container: Container
  private terminals: Record<string, TerminalSession> = {}

  constructor(container: Container) {
    this.container = container
  }

  async createTerminal(id: string, onData: (output: string) => void): Promise<void> {
    if (this.terminals[id]) {
      return
    }

    const exec = await this.container.exec({
      Cmd: ["/bin/bash"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })

    const stream = await exec.start({ hijack: true, stdin: true })

    stream.on("data", (chunk: Buffer) => {
      onData(chunk.toString("utf-8"))
    })

    this.terminals[id] = { exec, stream }

    // Example initial commands
    stream.write("cd /home/user/project\r")
    stream.write("clear\r")

    logger.info(`Created Docker terminal: ${id}`)
  }

  async sendTerminalData(id: string, data: string): Promise<void> {
    const session = this.terminals[id]
    if (!session) return
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
    session.stream.write("exit\r")
    delete this.terminals[id]
  }

  async closeAllTerminals() {
    for (const id of Object.keys(this.terminals)) {
      await this.closeTerminal(id)
    }
  }
}
