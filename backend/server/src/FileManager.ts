// /backend/server/src/FileManager.ts
import Docker, { Container } from "dockerode"
import JSZip from "jszip"
import path from "path"
import { spawn } from "child_process"
import RemoteFileStorage from "./RemoteFileStorage"
import { MAX_BODY_SIZE } from "./ratelimit"
import { TFile, TFileData, TFolder } from "./types"
import { generateFileStructure } from "./utils-filetree"
import tar from 'tar-stream'
import stream from 'stream'

/**
 * We'll store all project files in /workspace/data inside the container.
 * Make sure your Dockerfile or container environment has that folder.
 */
const PROJECT_DIR = "/workspace/data"

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
    console.log(`Initializing FileManager for sandbox ${this.sandboxId}`)
    try {
      // Download remote structure, sync to container, etc.
      await this.updateFileStructure()
      console.log(`File structure updated for sandbox ${this.sandboxId}`)
      await this.updateFileData()
      console.log(`File data updated for sandbox ${this.sandboxId}`)

      // Copy files into container using Docker's putArchive
      for (const f of this.fileData) {
        const containerPath = path.posix.join(PROJECT_DIR, f.id)
        console.log(`Writing file ${f.id} to ${containerPath}`)
        await this.writeToContainer(containerPath, f.data)
      }

      // Then load local container files
      await this.loadLocalFiles()
      console.log(`Local files loaded for sandbox ${this.sandboxId}`)

      // Start watchers with inotifywait
      await this.startWatcher(PROJECT_DIR)
      console.log(`Watcher started for ${PROJECT_DIR}`)
    } catch (error) {
      console.error(`Error during FileManager initialization for sandbox ${this.sandboxId}:`, error)
      throw error
    }
  }

  private async loadLocalFiles() {
    console.log(`Loading local files for sandbox ${this.sandboxId}`)
    // List all files from the container
    const { stdout, stderr } = await this.containerExec(`find "${PROJECT_DIR}" -type f`)
    if (stderr) {
      console.error(`Error finding files in container: ${stderr}`)
      return
    }

    const localPaths = stdout
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((f) => path.posix.relative(PROJECT_DIR, f))

    console.log(`Found ${localPaths.length} files in container`)
    this.files = generateFileStructure(localPaths)
    console.log(`Generated file structure:`, JSON.stringify(this.files, null, 2))
  }

  // Launch `inotifywait` in the container
  private async startWatcher(dir: string) {
    console.log(`Starting inotifywait watcher for directory: ${dir}`)
    // We'll do `docker exec` via the local shell. That means your Node server must have docker CLI installed
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
      lines.forEach((line) => {
        console.log(`Watcher event: ${line}`)
        this.handleInotifyEvent(line)
      })
    })

    this.watcherProcess.stderr.on("data", (err: Buffer) => {
      console.error("inotifywait error:", err.toString())
    })

    this.watcherProcess.on("exit", (code: any) => {
      console.log("inotifywait exited with code:", code)
    })
  }

  private handleInotifyEvent(line: string) {
    // Example line: "CREATE|/workspace/data/subfolder/|newfile.txt"
    const [rawEvent, watchDir, filename] = line.split("|")
    const eventTypes = rawEvent.split(",")

    console.log("inotify event:", rawEvent, "dir:", watchDir, "file:", filename)

    // For simplicity, we just reload everything and send a refresh
    this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  // Exec a command inside the container
  private async containerExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
    const exec = await this.container.exec({
      Cmd: ["bash", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({})

    let stdout = ""
    let stderr = ""

    await new Promise<void>((resolve, reject) => {
      this.container.modem.demuxStream(stream, 
        { write: (chunk) => { stdout += chunk.toString(); } },
        { write: (chunk) => { stderr += chunk.toString(); } }
      )
      stream.on("end", resolve)
      stream.on("error", reject)
    })

    if (stderr) {
      console.error(`Error executing command "${cmd}":`, stderr)
      // Optionally, you can throw an error here to stop the process
      // throw new Error(stderr)
    }

    console.log(`Executed command "${cmd}", stdout: ${stdout}`)
    return { stdout, stderr }
  }

  // Use Docker's putArchive to write files to the container
  private async writeToContainer(containerPath: string, data: string) {
    try {
      console.log(`Writing data to container path: ${containerPath}`)
      const pack = tar.pack()
      const relativePath = path.posix.relative('/', containerPath)

      pack.entry({ name: relativePath }, data)
      pack.finalize()

      await this.container.putArchive(pack, { path: '/' })
      console.log(`Successfully wrote to container at ${containerPath}`)
    } catch (error) {
      console.error(`Error writing to container at ${containerPath}:`, error)
      throw error
    }
  }

  // Download from remote => local
  private async updateFileData() {
    console.log(`Fetching sandbox paths for sandbox ${this.sandboxId}`)
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    console.log("Remote paths fetched:", remotePaths)

    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}`, "")
    )
    console.log("Local paths derived:", localPaths)

    this.fileData = await this.generateFileData(localPaths)
    console.log("File data generated:", this.fileData)
    return this.fileData
  }

  private async updateFileStructure() {
    console.log(`Fetching sandbox paths for file structure of sandbox ${this.sandboxId}`)
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    console.log("Remote paths fetched for structure:", remotePaths)

    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}`, "")
    )
    console.log("Local paths derived for structure:", localPaths)

    this.files = generateFileStructure(localPaths)
    console.log("Generated file structure:", JSON.stringify(this.files, null, 2))
    return this.files
  }

  private async generateFileData(paths: string[]): Promise<TFileData[]> {
    const results: TFileData[] = []
    for (const p of paths) {
      if (!p || p.endsWith("/")) continue
      console.log(`Fetching content for file: projects/${this.sandboxId}${p}`)
      const content = await RemoteFileStorage.fetchFileContent(
        `projects/${this.sandboxId}${p}`
      )
      if (content) {
        results.push({ id: p, data: content })
        console.log(`Fetched content for ${p}: ${content.substring(0, 100)}...`)
      } else {
        console.warn(`No content fetched for ${p}`)
      }
    }
    return results
  }

  // ---------- FileManager Methods ----------

  async getFile(fileId: string): Promise<string | undefined> {
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    const { stdout, stderr } = await this.containerExec(`cat "${containerPath}"`)
    if (stderr) {
      console.error(`Error getting file ${fileId}: ${stderr}`)
      return undefined
    }
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

    console.log(`Saving file ${fileId} with size ${Buffer.byteLength(body, "utf-8")} bytes`)
    await RemoteFileStorage.saveFile(`projects/${this.sandboxId}${fileId}`, body)

    let file = this.fileData.find((f) => f.id === fileId)
    if (file) {
      file.data = body
    } else {
      file = { id: fileId, data: body }
      this.fileData.push(file)
    }

    await this.writeToContainer(path.posix.join(PROJECT_DIR, fileId), body)
    console.log(`File ${fileId} saved successfully`)
  }

  async moveFile(fileId: string, folderId: string) {
    const parts = fileId.split("/")
    const newFileId = path.posix.join(folderId, parts[parts.length - 1])

    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    console.log(`Moving file from ${oldPath} to ${newPath}`)
    await this.containerExec(
      `mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`
    )

    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (dataEntry) {
      dataEntry.id = newFileId
      console.log(`Renaming file data entry from ${fileId} to ${newFileId}`)
      await RemoteFileStorage.renameFile(
        `projects/${this.sandboxId}${fileId}`,
        `projects/${this.sandboxId}${newFileId}`,
        dataEntry.data
      )
    }

    await this.updateFileStructure()
    console.log(`File structure updated after moving file`)
  }

  async createFile(name: string): Promise<boolean> {
    console.log(`Creating new file: ${name}`)
    const size = await RemoteFileStorage.getProjectSize(this.sandboxId)
    console.log(`Current project size: ${size} bytes`)
    if (size > 200 * 1024 * 1024) {
      throw new Error("Project size exceeded. Please delete some files.")
    }
    const id = `/${name}`
    await this.writeToContainer(path.posix.join(PROJECT_DIR, id), "")
    await RemoteFileStorage.createFile(`projects/${this.sandboxId}${id}`)
    console.log(`File ${name} created successfully`)
    return true
  }

  public async loadFileContent(): Promise<TFileData[]> {
    console.log(`Loading file content for sandbox ${this.sandboxId}`)
    const { stdout, stderr } = await this.containerExec(
      `find "${PROJECT_DIR}" -path "${PROJECT_DIR}/node_modules" -prune -o -type f -print`
    )
    if (stderr) {
      console.error(`Error finding files for download: ${stderr}`)
      return []
    }

    const filePaths = stdout.split("\n").map((p) => p.trim()).filter(Boolean)
    console.log(`Found ${filePaths.length} files for download`)

    for (const containerPath of filePaths) {
      const relative = path.posix.relative(PROJECT_DIR, containerPath)
      console.log(`Loading content for file: ${relative}`)
      const { stdout: fileContent, stderr: fileError } = await this.containerExec(`cat "${containerPath}"`)
      if (fileError) {
        console.error(`Error reading file ${relative}: ${fileError}`)
        continue
      }
      const existing = this.fileData.find((f) => f.id === relative)
      if (existing) {
        existing.data = fileContent
      } else {
        this.fileData.push({ id: relative, data: fileContent })
      }
    }
    console.log(`File content loaded for download`)
    return this.fileData
  }

  public async getFilesForDownload(): Promise<string> {
    console.log(`Preparing files for download in sandbox ${this.sandboxId}`)
    const zip = new JSZip()
    await this.loadFileContent()
    if (this.fileData.length === 0) {
      console.log("No files found to download")
      return ""
    }

    for (const f of this.fileData) {
      zip.file(f.id, f.data)
      console.log(`Added file to zip: ${f.id}`)
    }
    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })
    const arrayBuf = await zipBlob.arrayBuffer()
    const base64 = Buffer.from(arrayBuf).toString('base64') // Use Buffer for Node.js
    console.log(`Files zipped successfully`)
    return base64
  }

  async createFolder(name: string) {
    console.log(`Creating new folder: ${name}`)
    const id = `/${name}`
    await this.containerExec(`mkdir -p "${path.posix.join(PROJECT_DIR, id)}"`)
    await RemoteFileStorage.createFile(`projects/${this.sandboxId}${id}/.keep`) // Optionally, create a .keep file
    console.log(`Folder ${name} created successfully`)
  }

  async renameFile(fileId: string, newName: string) {
    console.log(`Renaming file ${fileId} to ${newName}`)
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
    console.log(`File ${fileId} renamed to ${newFileId} successfully`)
  }

  async deleteFile(fileId: string) {
    console.log(`Deleting file: ${fileId}`)
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) {
      console.warn(`File ${fileId} not found in fileData`)
      return
    }

    await this.containerExec(`rm -f "${path.posix.join(PROJECT_DIR, fileId)}"`)
    await RemoteFileStorage.deleteFile(`projects/${this.sandboxId}${fileId}`)
    console.log(`File ${fileId} deleted successfully`)
    return this.updateFileStructure()
  }

  async deleteFolder(folderId: string) {
    console.log(`Deleting folder: ${folderId}`)
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
      console.log(`Deleted file from container and R2: ${fileKey}`)
    }
    return this.updateFileStructure()
  }

  // Stop the inotifywait process
  async closeWatchers() {
    if (this.watcherProcess) {
      console.log(`Stopping watcher process for sandbox ${this.sandboxId}`)
      this.watcherProcess.kill("SIGINT")
      this.watcherProcess = null
    }
  }
}
