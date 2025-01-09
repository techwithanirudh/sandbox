// /backend/server/src/FileManager.ts

import { Container } from "dockerode"
import path from "path"
import tar from "tar-stream"
import RemoteFileStorage from "./RemoteFileStorage"
import { MAX_BODY_SIZE } from "./ratelimit"
import { TFile, TFileData, TFolder } from "./types"
import { generateFileStructure } from "./utils-filetree"

const PROJECT_DIR = "/workspaces/project"

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
   * Initialize the FileManager:
   * 1) Download the file structure & data from remote storage.
   * 2) Sync them into the container.
   * 3) Load the container's file list => memory.
   */
  async initialize(): Promise<void> {
    console.log(`[FileManager] Initializing for sandbox ${this.sandboxId}`)
    try {
      await this.updateFileStructure()
      await this.updateFileData()
      await this.syncFilesIntoContainer()
      await this.loadLocalFiles()
      console.log(
        `[FileManager] Initialization complete for sandbox ${this.sandboxId}`,
      )
    } catch (error) {
      console.error(`[FileManager] Error initializing:`, error)
      throw error
    }
  }

  /**
   * Get the contents of a given folder from remote storage.
   * Returns an array of local file paths within that folder.
   */
  public async getFolder(folderId: string): Promise<string[]> {
    // For remote: `folderId` might be something like "src" or "src/components"
    const remotePaths = await RemoteFileStorage.getFolder(
      `projects/${this.sandboxId}/${folderId}`,
    )
    // Strip the prefix so we get local file paths
    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}/`, ""),
    )
    return localPaths
  }

  /**
   * Helper that updates `this.files` by generating a file-tree structure.
   */
  private async updateFileStructure(): Promise<(TFolder | TFile)[]> {
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    const localPaths = remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}/`, ""),
    )
    this.files = generateFileStructure(localPaths)
    return this.files
  }

  /**
   * Helper that updates `this.fileData` by fetching file contents from remote.
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
   * Writes this.fileData into the container using tar-stream.
   */
  private async syncFilesIntoContainer(): Promise<void> {
    for (const file of this.fileData) {
      const containerPath = path.posix.join(PROJECT_DIR, file.id)
      await this.writeToContainer(containerPath, file.data)
    }
  }

  /**
   * Reads the container's file list via `find`, updates `this.files`.
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
   * Runs a command in the container, returning {stdout, stderr}.
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
   * Writes one file into the container using a tar-stream.
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

  public async saveFile(fileId: string, body: string): Promise<void> {
    if (Buffer.byteLength(body, "utf-8") > MAX_BODY_SIZE) {
      throw new Error("File size too large.")
    }

    // Save to remote
    const remoteId = `projects/${this.sandboxId}/${fileId}`
    await RemoteFileStorage.saveFile(remoteId, body)

    // Update in-memory
    let entry = this.fileData.find((f) => f.id === fileId)
    if (entry) {
      entry.data = body
    } else {
      entry = { id: fileId, data: body }
      this.fileData.push(entry)
    }

    // Write to container
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    await this.writeToContainer(containerPath, body)

    this.refreshFileList?.(this.files)
  }

  public async moveFile(fileId: string, folderId: string): Promise<void> {
    const parts = fileId.split("/")
    const newFileId = path.posix.join(folderId, parts[parts.length - 1])

    // Container move
    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.execInContainer(
      `mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`,
    )

    // rename in remote
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (dataEntry) {
      dataEntry.id = newFileId
      await RemoteFileStorage.renameFile(
        `projects/${this.sandboxId}/${fileId}`,
        `projects/${this.sandboxId}/${newFileId}`,
        dataEntry.data,
      )
    }

    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  public async createFile(name: string): Promise<boolean> {
    const size = await RemoteFileStorage.getProjectSize(this.sandboxId)
    if (size > 200 * 1024 * 1024) {
      throw new Error("Project size exceeded. Please delete some files.")
    }

    const fileId = `/${name}`
    const containerPath = path.posix.join(PROJECT_DIR, fileId)

    // create empty file in container
    await this.execInContainer(
      `mkdir -p "$(dirname "${containerPath}")" && touch "${containerPath}"`,
    )

    // create in remote
    const remoteFileId = `projects/${this.sandboxId}${fileId}`
    await RemoteFileStorage.createFile(remoteFileId)

    this.fileData.push({ id: name, data: "" })
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
    return true
  }

  /**
   * Create a new folder inside the container, and also store something on R2 to represent it (e.g., a .keep file).
   */
  public async createFolder(folderName: string): Promise<boolean> {
    const containerPath = path.posix.join(PROJECT_DIR, folderName)
    await this.execInContainer(`mkdir -p "${containerPath}"`)

    // On R2, store a .keep to represent the folder
    const remoteFolderPath = `projects/${this.sandboxId}/${folderName}/.keep`
    await RemoteFileStorage.createFile(remoteFolderPath)

    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
    return true
  }

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

    await RemoteFileStorage.renameFile(
      `projects/${this.sandboxId}/${fileId}`,
      `projects/${this.sandboxId}/${newFileId}`,
      dataEntry.data,
    )
    dataEntry.id = newFileId

    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  public async deleteFile(fileId: string): Promise<void> {
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) {
      console.warn(
        `[FileManager] File ${fileId} not found in memory, but removing anyway.`,
      )
    }

    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    await this.execInContainer(`rm -f "${containerPath}"`)

    await RemoteFileStorage.deleteFile(`projects/${this.sandboxId}/${fileId}`)
    this.fileData = this.fileData.filter((f) => f.id !== fileId)

    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  public async deleteFolder(folderId: string): Promise<void> {
    const remotePaths = await RemoteFileStorage.getFolder(
      `projects/${this.sandboxId}/${folderId}`,
    )
    for (const fileKey of remotePaths) {
      const containerPath = fileKey.replace(
        `projects/${this.sandboxId}/`,
        PROJECT_DIR + "/",
      )
      await this.execInContainer(`rm -rf "${containerPath}"`)
      await RemoteFileStorage.deleteFile(fileKey)

      const localId = fileKey.replace(`projects/${this.sandboxId}/`, "")
      this.fileData = this.fileData.filter((f) => f.id !== localId)
    }

    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Example method for creating a base64 ZIP of all files (for download).
   */
  public async getFilesForDownload(): Promise<string> {
    console.log(`[FileManager] Zipping files for sandbox ${this.sandboxId}`)
    if (this.fileData.length === 0) {
      console.log("[FileManager] No files found to download.")
      return ""
    }

    // Use "jszip" or "jzip"
    const JSZip = require("jszip")
    const zip = new JSZip()

    for (const file of this.fileData) {
      zip.file(file.id, file.data)
    }

    const zipBlob = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
    return zipBlob.toString("base64")
  }
}
