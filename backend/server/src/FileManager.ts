// /backend/server/src/FileManager.ts
import path from "path"
import { Container } from "dockerode"
import tar from "tar-stream"
import { TFile, TFileData, TFolder } from "./types"
import RemoteFileStorage from "./RemoteFileStorage"
import { MAX_BODY_SIZE } from "./ratelimit"
import { generateFileStructure } from "./utils-filetree"

/**
 * We will store all project files in /workspace/data inside the container.
 */
const PROJECT_DIR = "/workspace/data"

export class FileManager {
  private sandboxId: string
  private container: Container
  private refreshFileList: ((files: (TFolder | TFile)[]) => void) | null

  // The in-memory representation of the files.
  public files: (TFolder | TFile)[]
  public fileData: TFileData[]

  constructor(
    sandboxId: string,
    container: Container,
    refreshFileList: ((files: (TFolder | TFile)[]) => void) | null,
  ) {
    this.sandboxId = sandboxId
    this.container = container
    this.refreshFileList = refreshFileList

    this.files = []
    this.fileData = []
  }

  /**
   * Initialize the FileManager.
   * 1. Sync remote R2 storage -> local in-memory
   * 2. Copy those files into the container
   * 3. Then read the container's filesystem -> in-memory
   */
  async initialize(): Promise<void> {
    console.log(`[FileManager] Initializing for sandbox ${this.sandboxId}`)
    try {
      // 1) Pull the file structure from remote storage
      await this.updateFileStructure()

      // 2) Pull actual file data from remote
      await this.updateFileData()

      // 3) Write them to the container
      await this.syncFilesIntoContainer()

      // 4) Load the local container file list
      await this.loadLocalFiles()
      console.log(
        `[FileManager] Initialization complete for sandbox ${this.sandboxId}`,
      )
    } catch (error) {
      console.error(`[FileManager] Error during initialization:`, error)
      throw error
    }
  }

  /**
   * Updates `this.files` by generating a file-tree structure from the remote R2 storage paths.
   */
  private async updateFileStructure(): Promise<(TFolder | TFile)[]> {
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    // Strip the prefix "projects/sandboxId/"
    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}/`, ""),
    )
    this.files = generateFileStructure(localPaths)
    return this.files
  }

  /**
   * Updates `this.fileData` by fetching actual file contents from remote R2 storage.
   */
  private async updateFileData(): Promise<TFileData[]> {
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}/`, ""),
    )

    const results: TFileData[] = []
    for (const p of localPaths) {
      if (!p || p.endsWith("/")) continue
      const content = await RemoteFileStorage.fetchFileContent(
        `projects/${this.sandboxId}/${p}`,
      )
      results.push({ id: p, data: content })
    }
    this.fileData = results
    return this.fileData
  }

  /**
   * Copies all fileData into the container using tar-stream.
   */
  private async syncFilesIntoContainer(): Promise<void> {
    for (const file of this.fileData) {
      const containerPath = path.posix.join(PROJECT_DIR, file.id)
      await this.writeToContainer(containerPath, file.data)
    }
  }

  /**
   * Reads the container filesystem (all files under PROJECT_DIR) and regenerates `this.files`.
   */
  private async loadLocalFiles(): Promise<void> {
    const { stdout, stderr } = await this.execInContainer(
      `find "${PROJECT_DIR}" -type f`,
    )
    if (stderr) {
      console.error("[FileManager] Error listing container files:", stderr)
      return
    }

    const localPaths = stdout
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((fp) => path.posix.relative(PROJECT_DIR, fp))

    this.files = generateFileStructure(localPaths)
  }

  /**
   * Helper: execute a bash command inside the container, returning stdout/stderr.
   */
  private async execInContainer(
    cmd: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const exec = await this.container.exec({
      Cmd: ["bash", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({})
    let stdout = ""
    let stderr = ""

    await new Promise<void>((resolve, reject) => {
      this.container.modem.demuxStream(
        stream,
        {
          write: (chunk: Buffer) => {
            stdout += chunk.toString()
          },
        },
        {
          write: (chunk: Buffer) => {
            stderr += chunk.toString()
          },
        },
      )
      stream.on("end", resolve)
      stream.on("error", reject)
    })

    return { stdout, stderr }
  }

  /**
   * Helper: write a single file to the container at `containerPath` using tar-stream.
   */
  private async writeToContainer(
    containerPath: string,
    data: string,
  ): Promise<void> {
    try {
      const pack = tar.pack()
      const relativePath = containerPath.startsWith("/")
        ? containerPath.slice(1)
        : containerPath

      pack.entry({ name: relativePath }, data)
      pack.finalize()

      await this.container.putArchive(pack, { path: "/" })
    } catch (error) {
      console.error(
        `[FileManager] Error writing to container at ${containerPath}:`,
        error,
      )
      throw error
    }
  }

  // ----------------------------------------------------------------
  // Public API: File / Folder Operations
  // ----------------------------------------------------------------

  /**
   * Reads file content from container. Returns a string or undefined on error.
   */
  public async getFile(fileId: string): Promise<string | undefined> {
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    const { stdout, stderr } = await this.execInContainer(
      `cat "${containerPath}"`,
    )
    if (stderr) {
      console.error(`[FileManager] Error reading file ${fileId}:`, stderr)
      return undefined
    }
    return stdout
  }

  /**
   * Saves file content both to remote R2 storage and into the container.
   */
  public async saveFile(fileId: string, body: string): Promise<void> {
    if (Buffer.byteLength(body, "utf-8") > MAX_BODY_SIZE) {
      throw new Error("File size is too large.")
    }

    // 1) Save to remote R2
    const remoteId = `projects/${this.sandboxId}/${fileId}`
    await RemoteFileStorage.saveFile(remoteId, body)

    // 2) Update in-memory
    let existing = this.fileData.find((f) => f.id === fileId)
    if (existing) {
      existing.data = body
    } else {
      existing = { id: fileId, data: body }
      this.fileData.push(existing)
    }

    // 3) Write to container
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    await this.writeToContainer(containerPath, body)

    // Notify watchers
    this.refreshFileList?.(this.files)
  }

  /**
   * Moves a file from one folder to another in both container and remote.
   */
  public async moveFile(fileId: string, folderId: string): Promise<void> {
    const parts = fileId.split("/")
    const newFileId = path.posix.join(folderId, parts[parts.length - 1])

    // Move inside container
    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.execInContainer(
      `mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`,
    )

    // Rename in remote
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (dataEntry) {
      dataEntry.id = newFileId
      await RemoteFileStorage.renameFile(
        `projects/${this.sandboxId}/${fileId}`,
        `projects/${this.sandboxId}/${newFileId}`,
        dataEntry.data,
      )
    }

    // Reload structure
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Creates an empty file.
   * Similar logic to your original approach, but with Docker exec for the container, plus remote storage.
   */
  public async createFile(name: string): Promise<boolean> {
    const size = await RemoteFileStorage.getProjectSize(this.sandboxId)
    if (size > 200 * 1024 * 1024) {
      throw new Error("Project size exceeded. Please delete some files.")
    }

    const fileId = `/${name}`
    const containerPath = path.posix.join(PROJECT_DIR, fileId)

    // 1) Create empty file in container
    await this.execInContainer(
      `mkdir -p "$(dirname "${containerPath}")" && touch "${containerPath}"`,
    )

    // 2) Create file in R2
    const remoteFileId = `projects/${this.sandboxId}${fileId}`
    await RemoteFileStorage.createFile(remoteFileId)

    // 3) Update memory
    this.fileData.push({ id: name, data: "" })

    // Reload and notify watchers
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
    return true
  }

  /**
   * Creates a new folder by making a directory in the container and optionally storing something in remote storage to represent it.
   */
  public async createFolder(folderName: string): Promise<boolean> {
    // For instance, let's do `mkdir -p /workspace/data/folderName` in container
    const containerPath = path.posix.join(PROJECT_DIR, folderName)
    await this.execInContainer(`mkdir -p "${containerPath}"`)

    // In remote R2, you might store a `.keep` file so the folder is recognized
    const remoteFolderPath = `projects/${this.sandboxId}/${folderName}/.keep`
    await RemoteFileStorage.createFile(remoteFolderPath)

    // Reload local structure
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
    return true
  }

  /**
   * Renames a file's last path component to newName (similar to your old logic).
   */
  public async renameFile(fileId: string, newName: string): Promise<void> {
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) return

    const parts = fileId.split("/")
    parts[parts.length - 1] = newName
    const newFileId = parts.join("/")

    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.execInContainer(
      `mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`,
    )

    // Rename in remote
    await RemoteFileStorage.renameFile(
      `projects/${this.sandboxId}/${fileId}`,
      `projects/${this.sandboxId}/${newFileId}`,
      dataEntry.data,
    )
    dataEntry.id = newFileId

    // Reload
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Deletes a single file from container and from remote.
   */
  public async deleteFile(fileId: string): Promise<void> {
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) {
      console.warn(
        `[FileManager] File ${fileId} not found in memory, but deleting anyway.`,
      )
    }

    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    await this.execInContainer(`rm -f "${containerPath}"`)

    await RemoteFileStorage.deleteFile(`projects/${this.sandboxId}/${fileId}`)
    this.fileData = this.fileData.filter((f) => f.id !== fileId)

    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Deletes a folder and its contents (recursively) from both container and remote.
   */
  public async deleteFolder(folderId: string): Promise<void> {
    // 1) Get all remote paths in that folder
    const remotePaths = await RemoteFileStorage.getFolder(
      `projects/${this.sandboxId}/${folderId}`,
    )

    // 2) For each path, remove from container & remote
    for (const fileKey of remotePaths) {
      const containerPath = fileKey.replace(
        `projects/${this.sandboxId}/`,
        PROJECT_DIR + "/",
      )
      await this.execInContainer(`rm -rf "${containerPath}"`)
      await RemoteFileStorage.deleteFile(fileKey)

      // Remove from in-memory fileData
      const localId = fileKey.replace(`projects/${this.sandboxId}/`, "")
      this.fileData = this.fileData.filter((f) => f.id !== localId)
    }

    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Example method: Create a ZIP file of container contents, return as base64 string.
   * If you want a "download files" approach.
   */
  public async getFilesForDownload(): Promise<string> {
    console.log(
      `[FileManager] Zipping files for download in sandbox ${this.sandboxId}`,
    )

    // 1) Load container file content into memory
    //    (Or if you prefer, read from `this.fileData`)
    //    If you want the up-to-date container content, do container reads here.
    //    For brevity, I'll just use `this.fileData`.
    if (this.fileData.length === 0) {
      console.log("[FileManager] No files to download.")
      return ""
    }

    // 2) Use JSZip or a similar library to create a ZIP in-memory
    //    You already have jzip in your package.json, so let's do a quick example:
    //    However, "jzip" is a bit minimal; if you want "jszip", just import it. We'll assume jzip usage is similar.

    // Note: if you're definitely using 'jszip', do:
    // import JSZip from 'jszip'
    // const JSZip = require('jszip') // or import
    const JSZip = require("jszip") // for example
    const zip = new JSZip()

    // 3) Add files
    for (const fileEntry of this.fileData) {
      if (!fileEntry.id.endsWith("/")) {
        zip.file(fileEntry.id, fileEntry.data)
      }
    }

    // 4) Generate a Base64-encoded ZIP
    const zipContent: Buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
    const base64Zip = zipContent.toString("base64")

    return base64Zip
  }
}
