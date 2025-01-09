// /backend/server/src/InotifyWatcher.ts
import { spawn, ChildProcess } from "child_process"

/**
 * Describes the parsed event data from inotifywait.
 */
export interface InotifyEvent {
  /** The raw string of events, e.g. "CREATE,ISDIR" */
  rawEvents: string
  /** The directory being watched, e.g. "/workspace/data/src/" */
  watchDir: string
  /** The filename or folder name, e.g. "test.js" */
  filename: string
  /** The list of event flags from rawEvents, e.g. ["CREATE","ISDIR"] */
  events: string[]
  /** The relative path from your base directory, if desired (computed externally). */
  relativePath?: string
}

/**
 * Callback signature for handling an inotify event.
 */
export type InotifyEventHandler = (evt: InotifyEvent) => Promise<void> | void

/**
 * InotifyWatcher is a small library for spawning inotifywait inside a Docker container
 * via `docker exec`, and parsing the events in a structured manner.
 */
export class InotifyWatcher {
  private process: ChildProcess | null = null
  private isActive: boolean = false

  /**
   * Start watching a directory in the given container.
   * @param containerId - Docker container ID or name
   * @param directory   - Path inside the container to watch
   * @param onEvent     - Callback that receives each event
   */
  public startWatching(
    containerId: string,
    directory: string,
    onEvent: InotifyEventHandler,
  ): void {
    // If already active, do nothing
    if (this.isActive) {
      console.warn("[InotifyWatcher] Watcher is already running.")
      return
    }
    this.isActive = true

    console.log(
      `[InotifyWatcher] Starting watcher in container=${containerId} dir=${directory}`,
    )

    // Spawn: docker exec -i <containerId> inotifywait -m -r --format "%e|%w|%f" <directory>
    this.process = spawn("docker", [
      "exec",
      "-i",
      containerId,
      "inotifywait",
      "-m",
      "-r",
      "--format",
      "%e|%w|%f",
      directory,
    ])

    // Handle stdout lines
    this.process.stdout!.on("data", (data: Buffer) => {
      const lines = data.toString("utf-8").split("\n").filter(Boolean)
      for (const line of lines) {
        this.handleRawLine(line, onEvent)
      }
    })

    // Handle stderr
    this.process.stderr!.on("data", (err: Buffer) => {
      console.error("[InotifyWatcher] Error:", err.toString())
    })

    // On exit
    this.process.on("exit", (code) => {
      console.log(`[InotifyWatcher] Exited with code: ${code}`)
      this.isActive = false
      this.process = null
    })
  }

  /**
   * Parse each line, e.g. "CREATE|/workspace/data/src/|test.js"
   */
  private async handleRawLine(line: string, onEvent: InotifyEventHandler) {
    // line format is: "<EVENTS>|<WATCH_DIR>|<FILENAME>"
    // e.g. "CREATE,ISDIR|/workspace/data/src/|newFolder"
    const [rawEvents, watchDir, filename] = line.split("|")
    if (!rawEvents || !watchDir || !filename) {
      console.warn("[InotifyWatcher] Malformed line:", line)
      return
    }

    const events = rawEvents.split(",")
    const evt: InotifyEvent = {
      rawEvents,
      watchDir,
      filename,
      events,
    }

    try {
      await onEvent(evt)
    } catch (err) {
      console.error("[InotifyWatcher] Error in onEvent handler:", err)
    }
  }

  /**
   * Stop watching by killing the child process.
   */
  public stopWatching(): void {
    if (this.process) {
      console.log("[InotifyWatcher] Stopping watcher process...")
      this.process.kill("SIGINT")
      this.process = null
    }
    this.isActive = false
  }
}
