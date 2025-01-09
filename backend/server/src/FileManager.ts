import { Container } from "dockerode"
import JSZip from "jszip"
import path from "path"
import { spawn } from "child_process"
import RemoteFileStorage from "./RemoteFileStorage"
import { MAX_BODY_SIZE } from "./ratelimit"
import { TFile, TFileData, TFolder } from "./types"
import { generateFileStructure } from "./utils-filetree"

/**
 * Where in the container the project files live.
 * Make sure your Docker image has inotify-tools installed, e.g.:
 *   RUN apt-get update && apt-get install -y inotify-tools
 */
const PROJECT_DIR = "~/sandbox/backend/server/d-data"

export class FileManager {
  private sandboxId: string
  private container: Container
  public files: (TFolder | TFile)[]
  public fileData: TFileData[]
  private refreshFileList: ((files: (TFolder | TFile)[]) => void) | null

  // We'll store the child process for watchers
  private watcherProcess: any

  constructor(
    sandboxId: string,
    container: Container,
    refreshFileList: ((files: (TFolder | TFile)[]) => void) | null
  ) {
    this.sandboxId = sandboxId
    this.container = container
    this.files = []
    this.fileData = []
    this.refreshFileList = refreshFileList
  }

  async initialize() {
    // Get the existing remote file structure and sync it to container
    await this.updateFileStructure()
    await this.updateFileData()

    // Copy files into container
    for (const f of this.fileData) {
      const containerPath = path.posix.join(PROJECT_DIR, f.id)
      await this.writeToContainer(containerPath, f.data)
    }

    // Then load local container files
    await this.loadLocalFiles()

    // Start the watchers
    await this.startWatcher(PROJECT_DIR)
  }

  private async loadLocalFiles() {
    const { stdout } = await this.containerExec(`find "${PROJECT_DIR}" -type f`)
    const localPaths = stdout
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((f) => path.posix.relative(PROJECT_DIR, f))

    this.files = generateFileStructure(localPaths)
  }

  // Launch `inotifywait` in the container
  private async startWatcher(dir: string) {
    // We do a `docker exec -i <containerId> inotifywait -m -r <dir>`
    // dockerode doesn’t have a built-in “spawn exec as a ChildProcess,” 
    // so we hack it using the Docker CLI command, or we can emulate 
    // a streaming approach with `container.exec({Cmd: [...]})`.

    // For simplicity, let's do a local spawn of `docker exec`. 
    // (You do need `docker` CLI installed on your host for this approach.)
    // If you don’t want to rely on the CLI, you can do a more complex solution 
    // hooking into dockerode streams. But this is easier to illustrate:

    const containerInfo = await this.container.inspect()
    const containerId = containerInfo.Id

    this.watcherProcess = spawn("docker", [
      "exec",
      "-i",
      containerId,
      "inotifywait",
      "-m",
      "-r",
      "--format",
      "%e|%w|%f",
      dir,
    ])

    this.watcherProcess.stdout.on("data", (data: Buffer) => {
      const lines = data.toString("utf-8").split("\n").filter(Boolean)
      lines.forEach((line) => this.handleInotifyEvent(line))
    })

    this.watcherProcess.stderr.on("data", (err: Buffer) => {
      console.error("inotifywait error:", err.toString())
    })

    this.watcherProcess.on("exit", (code: any) => {
      console.log("inotifywait exited with code:", code)
    })
  }

  private handleInotifyEvent(line: string) {
    // Example line: "CREATE|/home/user/project/subfolder/|newfile.txt"
    const [rawEvent, watchDir, filename] = line.split("|")
    const eventTypes = rawEvent.split(",")

    // For instance, if rawEvent = "CREATE,ISDIR", we know a folder was created
    // We can do the same logic E2B watchers had: reload the file structure, 
    // update internal state, emit to refreshFileList, etc.

    console.log("inotify event:", rawEvent, "dir:", watchDir, "file:", filename)
    // Just re-load everything for simplicity:
    // (In a more efficient approach, you'd only update the changed item.)
    this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  // Exec a command inside the container, returning stdout/stderr
  private async containerExec(cmd: string) {
    const exec = await this.container.exec({
      Cmd: ["bash", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({})
    let stdout = ""
    let stderr = ""

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      stream.on("error", (err) => reject(err))
      stream.on("end", () => resolve())
    })

    return { stdout, stderr }
  }

  // Writes content to a file in the container
  private async writeToContainer(containerPath: string, data: string) {
    // Minimal echo-based approach
    const escapedData = data.replace(/"/g, '\\"')
    const cmd = `mkdir -p "$(dirname "${containerPath}")" && echo "${escapedData}" > "${containerPath}"`
    await this.containerExec(cmd)
  }

  /**
   * Remote => local
   */
  private async updateFileData() {
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}`, "")
    )
    this.fileData = await this.generateFileData(localPaths)
    return this.fileData
  }

  private async updateFileStructure() {
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}`, "")
    )
    this.files = generateFileStructure(localPaths)
    return this.files
  }

  private async generateFileData(paths: string[]): Promise<TFileData[]> {
    const results: TFileData[] = []
    for (const p of paths) {
      if (!p || p.endsWith("/")) continue
      const content = await RemoteFileStorage.fetchFileContent(
        `projects/${this.sandboxId}${p}`
      )
      results.push({ id: p, data: content })
    }
    return results
  }

  // *** The original FileManager-based methods ***

  async getFile(fileId: string): Promise<string | undefined> {
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    const { stdout } = await this.containerExec(`cat "${containerPath}"`)
    return stdout
  }

  async getFolder(folderId: string): Promise<string[]> {
    const remotePaths = await RemoteFileStorage.getFolder(
      `projects/${this.sandboxId}${folderId}`
    )
    return remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}`, "")
    )
  }

  async saveFile(fileId: string, body: string): Promise<void> {
    if (!fileId) return
    if (Buffer.byteLength(body, "utf-8") > MAX_BODY_SIZE) {
      throw new Error("File size too large. Please reduce the file size.")
    }

    // Save to remote
    await RemoteFileStorage.saveFile(`projects/${this.sandboxId}${fileId}`, body)

    // Update local cache
    let file = this.fileData.find((f) => f.id === fileId)
    if (file) {
      file.data = body
    } else {
      file = { id: fileId, data: body }
      this.fileData.push(file)
    }

    // Write to container
    await this.writeToContainer(path.posix.join(PROJECT_DIR, fileId), body)
  }

  async moveFile(fileId: string, folderId: string) {
    const parts = fileId.split("/")
    const newFileId = path.posix.join(folderId, parts[parts.length - 1])

    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.containerExec(
      `mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`
    )

    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (dataEntry) {
      dataEntry.id = newFileId
      await RemoteFileStorage.renameFile(
        `projects/${this.sandboxId}${fileId}`,
        `projects/${this.sandboxId}${newFileId}`,
        dataEntry.data
      )
    }

    return this.updateFileStructure()
  }

  async createFile(name: string): Promise<boolean> {
    const size = await RemoteFileStorage.getProjectSize(this.sandboxId)
    if (size > 200 * 1024 * 1024) {
      throw new Error("Project size exceeded. Please delete some files.")
    }
    const id = `/${name}`
    await this.containerExec(`touch "${path.posix.join(PROJECT_DIR, id)}"`)
    await RemoteFileStorage.createFile(`projects/${this.sandboxId}${id}`)
    return true
  }

  public async loadFileContent(): Promise<TFileData[]> {
    const { stdout } = await this.containerExec(
      `find "${PROJECT_DIR}" -path "${PROJECT_DIR}/node_modules" -prune -o -type f -print`
    )
    const filePaths = stdout
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)

    for (const containerPath of filePaths) {
      const relative = path.posix.relative(PROJECT_DIR, containerPath)
      const content = await this.containerExec(`cat "${containerPath}"`)
      const existing = this.fileData.find((f) => f.id === relative)
      if (existing) {
        existing.data = content.stdout
      } else {
        this.fileData.push({
          id: relative,
          data: content.stdout,
        })
      }
    }
    return this.fileData
  }

  public async getFilesForDownload(): Promise<string> {
    const zip = new JSZip()
    await this.loadFileContent()
    if (this.fileData.length === 0) {
      console.log("No files found to download")
      return ""
    }

    for (const f of this.fileData) {
      zip.file(f.id, f.data)
    }
    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })
    const arrayBuf = await zipBlob.arrayBuffer()
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)))
    return base64
  }

  async createFolder(name: string) {
    const id = `/${name}`
    await this.containerExec(
      `mkdir -p "${path.posix.join(PROJECT_DIR, id)}"`
    )
  }

  async renameFile(fileId: string, newName: string) {
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) return

    const parts = fileId.split("/")
    parts[parts.length - 1] = newName
    const newFileId = parts.join("/")

    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.containerExec(
      `mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`
    )

    await RemoteFileStorage.renameFile(
      `projects/${this.sandboxId}${fileId}`,
      `projects/${this.sandboxId}${newFileId}`,
      dataEntry.data
    )
    dataEntry.id = newFileId
  }

  async deleteFile(fileId: string) {
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) return this.files

    // Remove from container
    await this.containerExec(
      `rm -f "${path.posix.join(PROJECT_DIR, fileId)}"`
    )
    // Remove from remote
    await RemoteFileStorage.deleteFile(`projects/${this.sandboxId}${fileId}`)
    return this.updateFileStructure()
  }

  async deleteFolder(folderId: string) {
    const remotePaths = await RemoteFileStorage.getFolder(
      `projects/${this.sandboxId}${folderId}`
    )
    for (const fileKey of remotePaths) {
      const containerPath = fileKey.replace(
        `projects/${this.sandboxId}`,
        PROJECT_DIR
      )
      await this.containerExec(`rm -rf "${containerPath}"`)
      await RemoteFileStorage.deleteFile(fileKey)
    }
    return this.updateFileStructure()
  }

  // Stop the inotifywait process
  async closeWatchers() {
    if (this.watcherProcess) {
      this.watcherProcess.kill("SIGINT")
      this.watcherProcess = null
    }
  }
}
