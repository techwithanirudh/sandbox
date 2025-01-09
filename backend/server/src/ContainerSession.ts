// /backend/server/src/ContainerSession.ts
import { Container } from "dockerode"
import { spawn, ChildProcess } from "child_process"

export class ContainerSession {
  private container: Container
  private containerId: string
  private watchers: ChildProcess[] = []
  private timeoutMs: number
  private timeoutHandle?: NodeJS.Timeout

  constructor(container: Container, containerId: string, timeoutMs = 120_000) {
    this.container = container
    this.containerId = containerId
    this.timeoutMs = timeoutMs
  }

  /**
   * Run a command using dockerode exec
   */
  public async execCmd(
    cmd: string,
    cwd = "/workspace/data",
  ): Promise<{ stdout: string; stderr: string }> {
    const exec = await this.container.exec({
      Cmd: ["bash", "-c", `cd "${cwd}" && ${cmd}`],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({})
    let stdout = ""
    let stderr = ""

    await new Promise<void>((resolve, reject) => {
      this.container.modem.demuxStream(
        stream,
        { write: (chunk: any) => (stdout += chunk.toString()) },
        { write: (chunk: any) => (stderr += chunk.toString()) },
      )
      stream.on("end", resolve)
      stream.on("error", reject)
    })

    return { stdout, stderr }
  }

  /**
   * Start an inotify-based watcher by spawning local 'docker exec'
   */
  public startWatcher(dirToWatch: string, onEvent: (line: string) => void) {
    console.log(
      `[ContainerSession] Starting watcher in container ${this.containerId} on ${dirToWatch}`,
    )

    const child = spawn("docker", [
      "exec",
      "-i",
      this.container.id,
      "inotifywait",
      "-m", // monitor
      "-r", // recursive
      "--format",
      "%e|%w|%f",
      dirToWatch,
    ])

    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean)
      lines.forEach((line) => {
        onEvent(line)
      })
    })

    child.stderr.on("data", (data: Buffer) => {
      console.error(`[${this.containerId}] inotify stderr: ${data.toString()}`)
    })

    child.on("exit", (code) => {
      console.log(
        `[ContainerSession] Watcher for ${this.containerId} exited with code ${code}`,
      )
    })

    this.watchers.push(child)
  }

  public stopWatchers() {
    for (const w of this.watchers) {
      w.kill("SIGINT")
    }
    this.watchers = []
  }

  /**
   * Heartbeat-like approach: if not reset, we call onTimeout after `timeoutMs`.
   */
  public resetTimeout(onTimeout?: () => Promise<void>) {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle)

    this.timeoutHandle = setTimeout(async () => {
      console.log(`[ContainerSession] container ${this.containerId} timed out.`)
      this.stopWatchers()
      if (onTimeout) {
        await onTimeout()
      }
    }, this.timeoutMs)
  }

  public cleanup() {
    this.stopWatchers()
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
    }
  }
}
