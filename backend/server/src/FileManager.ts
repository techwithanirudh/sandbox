// /backend/server/src/FileManager.ts
import Docker, { Container } from "dockerode"
import JSZip from "jszip"
import path from "path"
import { Readable } from "stream"
import RemoteFileStorage from "./RemoteFileStorage"
import { MAX_BODY_SIZE } from "./ratelimit"
import { TFile, TFileData, TFolder } from "./types"
import { generateFileStructure } from "./utils-filetree"
import chokidar, { FSWatcher, WatchOptions } from "chokidar"
import winston from "winston"
import tar from "tar-stream"

// Initialize Logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }: winston.Logform.TransformableInfo) =>
        `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
})

/**
 * We'll store all project files in /workspace/data inside the container.
 * Ensure your Dockerfile or container environment has that folder.
 */
const PROJECT_DIR = "/workspace/data"

export class FileManager {
  private sandboxId: string
  private container: Container
  public files: (TFolder | TFile)[]
  public fileData: TFileData[]
  private refreshFileList: ((files: (TFolder | TFile)[]) => void) | null
  private watcher: FSWatcher | null

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
    this.watcher = null
  }

  /**
   * Initialize the FileManager by syncing files and setting up watchers
   */
  async initialize() {
    logger.info(`Initializing FileManager for sandbox ${this.sandboxId}`)
    try {
      await this.syncFromRemote()
      await this.syncToContainer()
      await this.loadLocalFiles()
      await this.setupWatcher()
      logger.info(`FileManager initialized for sandbox ${this.sandboxId}`)
    } catch (error) {
      logger.error(`Initialization failed for sandbox ${this.sandboxId}: ${error}`)
      throw error
    }
  }

  /**
   * Fetch files from R2 and prepare for syncing to the container
   */
  private async syncFromRemote() {
    logger.info(`Fetching file data from R2 for sandbox ${this.sandboxId}`)
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    logger.info(`Fetched ${remotePaths.length} paths from R2`)
    this.fileData = await Promise.all(
      remotePaths.map(async (fileKey) => {
        const relativePath = path.posix.relative(`projects/${this.sandboxId}/`, fileKey)
        const data = await RemoteFileStorage.fetchFileContent(fileKey)
        return { id: relativePath, data }
      })
    )
    logger.info(`Fetched file content from R2 for sandbox ${this.sandboxId}`)
  }

  /**
   * Sync fetched files to the Docker container
   */
  private async syncToContainer() {
    logger.info(`Syncing files to container for sandbox ${this.sandboxId}`)
    if (this.fileData.length === 0) {
      logger.info(`No files to sync for sandbox ${this.sandboxId}`)
      return
    }

    const tarStream = this.createTarStream(this.fileData)
    await this.container.putArchive(tarStream, { path: PROJECT_DIR })
    logger.info(`Files synced to container for sandbox ${this.sandboxId}`)
  }

  /**
   * Load local files from the container for in-memory representation
   */
  private async loadLocalFiles() {
    logger.info(`Loading local files from container for sandbox ${this.sandboxId}`)
    const filePaths = await this.executeContainerCommand(`find "${PROJECT_DIR}" -type f`)
    const localPaths = filePaths
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((f) => path.posix.relative(PROJECT_DIR, f))

    logger.info(`Found ${localPaths.length} files in container`)
    this.files = generateFileStructure(localPaths)
    logger.info(`Generated file structure for sandbox ${this.sandboxId}`)
  }

  /**
   * Set up `chokidar` watcher to monitor file changes
   */
  private async setupWatcher() {
    logger.info(`Setting up file watcher for sandbox ${this.sandboxId}`)
    const watchPath = path.posix.join(PROJECT_DIR, "**/*")
    const options: WatchOptions = {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    }

    this.watcher = chokidar.watch(watchPath, options)

    this.watcher
      .on("add", (filePath) => this.handleFileChange("add", filePath))
      .on("change", (filePath) => this.handleFileChange("change", filePath))
      .on("unlink", (filePath) => this.handleFileChange("unlink", filePath))
      .on("addDir", (dirPath) => this.handleDirChange("addDir", dirPath))
      .on("unlinkDir", (dirPath) => this.handleDirChange("unlinkDir", dirPath))
      .on("error", (error) => logger.error(`Watcher error: ${error}`))

    logger.info(`File watcher established for sandbox ${this.sandboxId}`)
  }

  /**
   * Handle file changes (add/change/unlink)
   */
  private async handleFileChange(event: string, filePath: string) {
    const relativePath = path.posix.relative(PROJECT_DIR, filePath)
    logger.info(`File event '${event}' detected for: ${relativePath}`)

    if (event === "add" || event === "change") {
      try {
        const content = await this.getFileContent(relativePath)
        await RemoteFileStorage.saveFile(`projects/${this.sandboxId}/${relativePath}`, content)
        logger.info(`File ${relativePath} synced to R2`)
      } catch (error) {
        logger.error(`Failed to sync file ${relativePath} to R2: ${error}`)
      }
    } else if (event === "unlink") {
      try {
        await RemoteFileStorage.deleteFile(`projects/${this.sandboxId}/${relativePath}`)
        logger.info(`File ${relativePath} deleted from R2`)
      } catch (error) {
        logger.error(`Failed to delete file ${relativePath} from R2: ${error}`)
      }
    }

    await this.updateFileStructure()
    this.refreshFileList?.(this.files)
  }

  /**
   * Handle directory changes (addDir/unlinkDir)
   */
  private async handleDirChange(event: string, dirPath: string) {
    const relativePath = path.posix.relative(PROJECT_DIR, dirPath)
    logger.info(`Directory event '${event}' detected for: ${relativePath}`)

    const r2Path = `projects/${this.sandboxId}/${relativePath}/.keep`

    if (event === "addDir") {
      try {
        await RemoteFileStorage.createFile(r2Path)
        logger.info(`Directory ${relativePath} created in R2 with .keep file`)
      } catch (error) {
        logger.error(`Failed to create directory ${relativePath} in R2: ${error}`)
      }
    } else if (event === "unlinkDir") {
      try {
        await RemoteFileStorage.deleteFile(r2Path)
        logger.info(`Directory ${relativePath} deleted from R2`)
      } catch (error) {
        logger.error(`Failed to delete directory ${relativePath} from R2: ${error}`)
      }
    }

    await this.updateFileStructure()
    this.refreshFileList?.(this.files)
  }

  /**
   * Execute a command inside the Docker container and return stdout
   */
  private async executeContainerCommand(cmd: string): Promise<string> {
    try {
      const exec = await this.container.exec({
        Cmd: ["bash", "-c", cmd],
        AttachStdout: true,
        AttachStderr: true,
      })
      const stream = await exec.start({})

      return await new Promise<string>((resolve, reject) => {
        let stdout = ""
        let stderr = ""

        this.container.modem.demuxStream(
          stream,
          { write: (chunk: Buffer) => { stdout += chunk.toString(); } },
          { write: (chunk: Buffer) => { stderr += chunk.toString(); } }
        )

        stream.on("end", () => {
          if (stderr) {
            logger.error(`Command "${cmd}" stderr: ${stderr}`)
            resolve("") // Return empty string on error
          } else {
            resolve(stdout.trim())
          }
        })

        stream.on("error", (err) => reject(err))
      })
    } catch (error) {
      logger.error(`Failed to execute command "${cmd}": ${error}`)
      return ""
    }
  }

  /**
   * Retrieve file content from the container
   */
  private async getFileContent(relativePath: string): Promise<string> {
    const fullPath = path.posix.join(PROJECT_DIR, relativePath)
    const content = await this.executeContainerCommand(`cat "${fullPath}"`)
    if (!content) {
      throw new Error(`Failed to read file: ${relativePath}`)
    }
    return content
  }

  /**
   * Create a tar stream from file data
   */
  private createTarStream(files: TFileData[]): Readable {
    const tarStream = tar.pack()
    files.forEach((file) => {
      tarStream.entry({ name: file.id }, file.data)
    })
    tarStream.finalize()
    return tarStream
  }

  /**
   * Update the in-memory file structure by fetching from R2
   */
  private async updateFileStructure() {
    logger.info(`Updating file structure for sandbox ${this.sandboxId}`)
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    this.files = generateFileStructure(
      remotePaths.map((r) => path.posix.relative(`projects/${this.sandboxId}/`, r))
    )
    logger.info(`File structure updated for sandbox ${this.sandboxId}`)
  }

  /**
   * Public Methods Accessible from Sandbox.ts
   */

  /**
   * Get a file's content
   */
  public async getFile(fileId: string): Promise<string | undefined> {
    const fullPath = path.posix.join(PROJECT_DIR, fileId)
    try {
      const content = await this.executeContainerCommand(`cat "${fullPath}"`)
      return content || undefined
    } catch (error) {
      logger.error(`Error getting file ${fileId}: ${error}`)
      return undefined
    }
  }

  /**
   * Get a folder's contents
   */
  public async getFolder(folderId: string): Promise<string[]> {
    const remotePaths = await RemoteFileStorage.getFolder(
      `projects/${this.sandboxId}/${folderId}`
    )
    return remotePaths.map((r) =>
      r.replace(`projects/${this.sandboxId}/`, "")
    )
  }

  /**
   * Save a file's content
   */
  public async saveFile(fileId: string, body: string): Promise<void> {
    if (!fileId) return
    if (Buffer.byteLength(body, "utf-8") > MAX_BODY_SIZE) {
      throw new Error("File size too large. Please reduce the file size.")
    }

    logger.info(`Saving file ${fileId} with size ${Buffer.byteLength(body, "utf-8")} bytes`)
    const saveSuccess = await RemoteFileStorage.saveFile(`projects/${this.sandboxId}/${fileId}`, body)
    if (!saveSuccess) {
      throw new Error(`Failed to save file ${fileId} to R2`)
    }

    let file = this.fileData.find((f) => f.id === fileId)
    if (file) {
      file.data = body
    } else {
      file = { id: fileId, data: body }
      this.fileData.push(file)
    }

    await this.syncToContainer()
    logger.info(`File ${fileId} saved successfully`)
  }

  /**
   * Move a file to a new folder
   */
  public async moveFile(fileId: string, folderId: string): Promise<void> {
    const newFileId = path.posix.join(folderId, path.posix.basename(fileId))
    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)

    logger.info(`Moving file from ${oldPath} to ${newPath}`)
    await this.executeContainerCommand(`mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`)

    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (dataEntry) {
      dataEntry.id = newFileId
      logger.info(`Renamed file data entry from ${fileId} to ${newFileId}`)
      const renameSuccess = await RemoteFileStorage.renameFile(
        `projects/${this.sandboxId}/${fileId}`,
        `projects/${this.sandboxId}/${newFileId}`,
        dataEntry.data
      )
      if (!renameSuccess) {
        throw new Error(`Failed to rename file ${fileId} to ${newFileId} in R2`)
      }
    }

    await this.updateFileStructure()
    this.refreshFileList?.(this.files)
  }

  /**
   * Create a new file
   */
  public async createFile(name: string): Promise<boolean> {
    logger.info(`Creating new file: ${name}`)
    const size = await RemoteFileStorage.getProjectSize(this.sandboxId)
    logger.info(`Current project size: ${size} bytes`)
    if (size > 200 * 1024 * 1024) {
      throw new Error("Project size exceeded. Please delete some files.")
    }
    const id = `/${name}`
    await this.executeContainerCommand(`touch "${path.posix.join(PROJECT_DIR, id)}"`)
    const createSuccess = await RemoteFileStorage.createFile(`projects/${this.sandboxId}/${id}`)
    if (!createSuccess) {
      throw new Error(`Failed to create file ${id} in R2`)
    }
    logger.info(`File ${name} created successfully`)
    return true
  }

  /**
   * Create a new folder
   */
  public async createFolder(name: string): Promise<void> {
    logger.info(`Creating new folder: ${name}`)
    const id = `/${name}`
    await this.executeContainerCommand(`mkdir -p "${path.posix.join(PROJECT_DIR, id)}"`)
    await RemoteFileStorage.createFile(`projects/${this.sandboxId}/${id}/.keep`)
    logger.info(`Folder ${name} created successfully`)
  }

  /**
   * Rename a file
   */
  public async renameFile(fileId: string, newName: string): Promise<void> {
    logger.info(`Renaming file ${fileId} to ${newName}`)
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) return

    const newFileId = path.posix.join(path.posix.dirname(fileId), newName)
    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.executeContainerCommand(`mv "${oldPath}" "${newPath}"`)

    dataEntry.id = newFileId
    logger.info(`File data entry renamed to ${newFileId}`)

    const renameSuccess = await RemoteFileStorage.renameFile(
      `projects/${this.sandboxId}/${fileId}`,
      `projects/${this.sandboxId}/${newFileId}`,
      dataEntry.data
    )
    if (!renameSuccess) {
      throw new Error(`Failed to rename file ${fileId} to ${newFileId} in R2`)
    }

    await this.updateFileStructure()
    this.refreshFileList?.(this.files)
  }

  /**
   * Delete a file
   */
  public async deleteFile(fileId: string): Promise<void> {
    logger.info(`Deleting file: ${fileId}`)
    const dataEntry = this.fileData.find((f) => f.id === fileId)
    if (!dataEntry) {
      logger.warn(`File ${fileId} not found in fileData`)
      return
    }

    await this.executeContainerCommand(`rm -f "${path.posix.join(PROJECT_DIR, fileId)}"`)
    const deleteSuccess = await RemoteFileStorage.deleteFile(`projects/${this.sandboxId}/${fileId}`)
    if (!deleteSuccess) {
      throw new Error(`Failed to delete file ${fileId} from R2`)
    }
    logger.info(`File ${fileId} deleted successfully`)
    await this.updateFileStructure()
  }

  /**
   * Delete a folder
   */
  public async deleteFolder(folderId: string): Promise<void> {
    logger.info(`Deleting folder: ${folderId}`)
    const remotePaths = await RemoteFileStorage.getFolder(
      `projects/${this.sandboxId}/${folderId}`
    )
    for (const fileKey of remotePaths) {
      const containerPath = fileKey.replace(
        `projects/${this.sandboxId}/`,
        path.posix.join(PROJECT_DIR, '')
      )
      await this.executeContainerCommand(`rm -rf "${containerPath}"`)
      const deleteSuccess = await RemoteFileStorage.deleteFile(fileKey)
      if (!deleteSuccess) {
        logger.warn(`Failed to delete file ${fileKey} from R2`)
      } else {
        logger.info(`Deleted file from container and R2: ${fileKey}`)
      }
    }
    await this.updateFileStructure()
  }

  /**
   * Load file content into memory
   */
  public async loadFileContent(): Promise<TFileData[]> {
    logger.info(`Loading file content for sandbox ${this.sandboxId}`)
    const filePaths = await this.executeContainerCommand(
      `find "${PROJECT_DIR}" -path "${PROJECT_DIR}/node_modules" -prune -o -type f -print`
    )
    const localPaths = filePaths
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    logger.info(`Found ${localPaths.length} files for download`)

    this.fileData = await Promise.all(
      localPaths.map(async (containerPath) => {
        const relative = path.posix.relative(PROJECT_DIR, containerPath)
        logger.info(`Loading content for file: ${relative}`)
        const content = await this.getFileContent(relative)
        return { id: relative, data: content }
      })
    )
    logger.info(`File content loaded for download`)
    return this.fileData
  }

  /**
   * Prepare files for download as a ZIP archive
   */
  public async getFilesForDownload(): Promise<string> {
    logger.info(`Preparing files for download in sandbox ${this.sandboxId}`)
    const zip = new JSZip()
    await this.loadFileContent()
    if (this.fileData.length === 0) {
      logger.info("No files found to download")
      return ""
    }

    this.fileData.forEach((f) => {
      zip.file(f.id, f.data)
      logger.info(`Added file to zip: ${f.id}`)
    })

    const zipBlob = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    })
    const base64 = zipBlob.toString('base64') // Use Buffer for Node.js
    logger.info(`Files zipped successfully`)
    return base64
  }

  /**
   * Clean up watchers when done
   */
  async closeWatchers() {
    if (this.watcher) {
      logger.info(`Closing file watcher for sandbox ${this.sandboxId}`)
      await this.watcher.close()
      this.watcher = null
      logger.info(`File watcher closed for sandbox ${this.sandboxId}`)
    }
  }
}
