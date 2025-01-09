// /backend/server/src/Sandbox.ts
import Docker, { Container } from "dockerode"
import { Socket } from "socket.io"
import { CONTAINER_TIMEOUT } from "./constants"
import { DokkuClient } from "./DokkuClient"
import { FileManager } from "./FileManager"
import {
  createFileRL,
  createFolderRL,
  deleteFileRL,
  renameFileRL,
  saveFileRL,
} from "./ratelimit"
import { SecureGitClient } from "./SecureGitClient"
import { TerminalManager } from "./TerminalManager"
import { TFile, TFolder } from "./types"
import { LockManager } from "./utils"
import logger from "./logger"

const lockManager = new LockManager()

type DockerContext = {
  dockerClient: Docker
  dokkuClient: DokkuClient | null
  gitClient: SecureGitClient | null
}

/**
 * Helper to parse a "http://localhost:xxxx" style port from output
 */
function extractPortNumber(inputString: string): number | null {
  const cleanedString = inputString.replace(/\x1B\[[0-9;]*m/g, "")
  const regex = /http:\/\/localhost:(\d+)/
  const match = cleanedString.match(regex)
  return match ? parseInt(match[1]) : null
}

export class Sandbox {
  sandboxId: string
  type: string
  fileManager: FileManager | null
  terminalManager: TerminalManager | null
  container: Container | null

  dokkuClient: DokkuClient | null
  gitClient: SecureGitClient | null

  dockerClient: Docker

  constructor(
    sandboxId: string,
    type: string,
    { dockerClient, dokkuClient, gitClient }: DockerContext
  ) {
    this.sandboxId = sandboxId
    this.type = type
    this.fileManager = null
    this.terminalManager = null
    this.container = null
    this.dockerClient = dockerClient
    this.dokkuClient = dokkuClient
    this.gitClient = gitClient
  }

  private async ensureContainerExists() {
    if (this.container) {
      try {
        const inspect = await this.container.inspect()
        if (inspect.State.Running) {
          logger.info(`Container ${this.sandboxId} is already running`)
          return
        }
      } catch (err) {
        logger.warn(`Error reusing container for ${this.sandboxId}: ${err}`)
      }
    }

    try {
      const existing = this.dockerClient.getContainer(this.sandboxId)
      await existing.remove({ force: true })
      logger.info(`Removed old container with name ${this.sandboxId}`)
    } catch {
      // It's okay if it doesn't exist
    }

    const templateTypes = ["vanillajs", "reactjs", "nextjs", "streamlit", "php"]
    const baseImage = templateTypes.includes(this.type)
      ? `gitwit-${this.type}`
      : "gitwit-universal"

    try {
      await this.dockerClient.pull(baseImage)
      logger.info(`Pulled (or found) image ${baseImage}`)
    } catch (error) {
      logger.warn(`Could not pull image ${baseImage} (might be local-only). ${error}`)
    }

    const hostPath = `/var/sandbox/volumes/${this.sandboxId}`
    logger.info(`Creating container for sandbox ${this.sandboxId}`)

    this.container = await this.dockerClient.createContainer({
      Image: baseImage,
      name: this.sandboxId,
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: [`${hostPath}:/workspace/data`],
      },
    })

    await this.container.start()
    logger.info(`Container started for sandbox ${this.sandboxId}`)
  }

  async initialize(fileWatchCallback: ((files: (TFolder | TFile)[]) => void) | undefined) {
    await lockManager.acquireLock(this.sandboxId, async () => {
      await this.ensureContainerExists()
    })

    if (!this.container) {
      throw new Error("Failed to create Docker container")
    }

    if (!this.terminalManager) {
      this.terminalManager = new TerminalManager(this.container)
      logger.info(`Terminal manager set up for ${this.sandboxId}`)
    }

    if (!this.fileManager) {
      this.fileManager = new FileManager(
        this.sandboxId,
        this.container,
        fileWatchCallback ?? null
      )
      await this.fileManager.initialize()
    }
  }

  async disconnect() {
    await this.terminalManager?.closeAllTerminals()
    this.terminalManager = null

    await this.fileManager?.closeWatchers()
    this.fileManager = null

    if (this.container) {
      try {
        await this.container.stop()
        await this.container.remove({ force: true })
        logger.info(`Stopped and removed container ${this.sandboxId}`)
      } catch (error) {
        logger.error(`Error removing container ${this.sandboxId}: ${error}`)
      }
    }
    this.container = null
  }

  handlers(connection: { userId: string; isOwner: boolean; socket: Socket }) {
    const handleHeartbeat = () => {
      logger.info(`Heartbeat from sandbox ${this.sandboxId}`)
    }

    // File operations
    const handleGetFile = ({ fileId }: any) => {
      return this.fileManager?.getFile(fileId)
    }
    const handleGetFolder = ({ folderId }: any) => {
      return this.fileManager?.getFolder(folderId)
    }
    const handleSaveFile = async ({ fileId, body }: any) => {
      await saveFileRL.consume(connection.userId, 1)
      return this.fileManager?.saveFile(fileId, body)
    }
    const handleMoveFile = async ({ fileId, folderId }: any) => {
      return this.fileManager?.moveFile(fileId, folderId)
    }
    const handleCreateFile = async ({ name }: any) => {
      await createFileRL.consume(connection.userId, 1)
      return { success: await this.fileManager?.createFile(name) }
    }
    const handleCreateFolder = async ({ name }: any) => {
      await createFolderRL.consume(connection.userId, 1)
      return { success: await this.fileManager?.createFolder(name) }
    }
    const handleRenameFile = async ({ fileId, newName }: any) => {
      await renameFileRL.consume(connection.userId, 1)
      return this.fileManager?.renameFile(fileId, newName)
    }
    const handleDeleteFile = async ({ fileId }: any) => {
      await deleteFileRL.consume(connection.userId, 1)
      return this.fileManager?.deleteFile(fileId)
    }
    const handleDeleteFolder = async ({ folderId }: any) => {
      return this.fileManager?.deleteFolder(folderId)
    }
    const handleDownloadFiles = async () => {
      if (!this.fileManager) throw Error("No file manager")
      const zipBase64 = await this.fileManager.getFilesForDownload()
      return { zipBlob: zipBase64 }
    }

    // Dokku events
    const handleListApps = async () => {
      if (!this.dokkuClient) throw new Error("No Dokku client available.")
      return { success: true, apps: await this.dokkuClient.listApps() }
    }
    const handleGetAppCreatedAt = async ({ appName }: any) => {
      if (!this.dokkuClient) throw new Error("No Dokku client available.")
      return {
        success: true,
        createdAt: await this.dokkuClient.getAppCreatedAt(appName),
      }
    }
    const handleAppExists = async ({ appName }: any) => {
      if (!this.dokkuClient) return { success: false }
      if (!this.dokkuClient.isConnected) return { success: false }
      return { success: true, exists: await this.dokkuClient.appExists(appName) }
    }
    const handleDeploy = async () => {
      if (!this.gitClient) throw Error("No git client")
      if (!this.fileManager) throw Error("No file manager")
      await this.gitClient.pushFiles(
        await this.fileManager?.loadFileContent(),
        this.sandboxId
      )
      return { success: true }
    }

    // Terminal
    const handleCreateTerminal = async ({ id }: any) => {
      await lockManager.acquireLock(this.sandboxId, async () => {
        await this.terminalManager?.createTerminal(id, (output: string) => {
          connection.socket.emit("terminalResponse", { id, data: output })
          const port = extractPortNumber(output)
          if (port) {
            connection.socket.emit("previewURL", `http://localhost:${port}`)
          }
        })
      })
    }
    const handleResizeTerminal = ({ dimensions }: any) => {
      this.terminalManager?.resizeTerminal(dimensions)
    }
    const handleTerminalData = ({ id, data }: any) => {
      return this.terminalManager?.sendTerminalData(id, data)
    }
    const handleCloseTerminal = ({ id }: any) => {
      return this.terminalManager?.closeTerminal(id)
    }

    return {
      heartbeat: handleHeartbeat,
      getFile: handleGetFile,
      getFolder: handleGetFolder,
      saveFile: handleSaveFile,
      moveFile: handleMoveFile,
      createFile: handleCreateFile,
      createFolder: handleCreateFolder,
      renameFile: handleRenameFile,
      deleteFile: handleDeleteFile,
      deleteFolder: handleDeleteFolder,
      downloadFiles: handleDownloadFiles,
      listApps: handleListApps,
      getAppCreatedAt: handleGetAppCreatedAt,
      getAppExists: handleAppExists,
      deploy: handleDeploy,
      createTerminal: handleCreateTerminal,
      resizeTerminal: handleResizeTerminal,
      terminalData: handleTerminalData,
      closeTerminal: handleCloseTerminal,
    }
  }
}
