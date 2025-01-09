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

// Initialize Logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`
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

        this.container.modem.demuxStream(stream, 
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
    const tar = require("tar-stream").pack()
    files.forEach((file) => {
      tar.entry({ name: file.id }, file.data)
    })
    tar.finalize()
    return tar
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

  // Additional methods (getFile, saveFile, createFile, etc.) can be similarly refactored
}
