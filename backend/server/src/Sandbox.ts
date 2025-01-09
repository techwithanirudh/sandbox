import Docker, { Container } from "dockerode"
import { Socket } from "socket.io"
import { CONTAINER_TIMEOUT } from "./constants"
import { ConnectionManager } from "./ConnectionManager"
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

const lockManager = new LockManager()

type DockerContext = {
  dockerClient: Docker
  dokkuClient: DokkuClient | null
  gitClient: SecureGitClient | null
}

/**
 * Helper to parse a "http://localhost:xxxx" style port from output,
 * in case you want to turn that into a preview URL.
 */
function extractPortNumber(inputString: string): number | null {
  const cleanedString = inputString.replace(/\x1B\[[0-9;]*m/g, "")
  const regex = /http:\/\/localhost:(\d+)/
  const match = cleanedString.match(regex)
  return match ? parseInt(match[1]) : null
}

/**
 * The Sandbox replaces the old E2B environment with:
 *   - Docker container management (dockerode)
 *   - Terminal manager (Docker exec)
 *   - File watchers (via inotifywait in the container)
 *   - Dokku for deployment
 */
export class Sandbox {
  sandboxId: string
  type: string
  fileManager: FileManager | null
  terminalManager: TerminalManager | null
  container: Container | null

  // For deployment:
  dokkuClient: DokkuClient | null
  gitClient: SecureGitClient | null

  // For Docker
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

    // Docker stuff
    this.dockerClient = dockerClient

    // Keep Dokku references
    this.dokkuClient = dokkuClient
    this.gitClient = gitClient
  }

  // Create or reuse a Docker container
  private async ensureContainerExists() {
    if (this.container) {
      try {
        const inspect = await this.container.inspect()
        if (inspect.State.Running) {
          console.log(`Container ${this.sandboxId} is already running`)
          return
        }
      } catch (err) {
        console.log(`Error reusing container for ${this.sandboxId}`, err)
      }
    }

    const templateTypes = ["vanillajs", "reactjs", "nextjs", "streamlit", "php"]
    const baseImage = templateTypes.includes(this.type)
      ? `gitwit-${this.type}`
      : "base"

    // Make sure we have the image (pull if needed)
    try {
      await this.dockerClient.pull(baseImage)
      console.log(`Pulled image ${baseImage}`)
    } catch (error) {
      console.error(`Error pulling image ${baseImage}:`, error)
      throw error
    }

    // Create + start container
    console.log(`Creating container for sandbox ${this.sandboxId}`)
    this.container = await this.dockerClient.createContainer({
      Image: baseImage,
      name: this.sandboxId,
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      // ...
    })
    await this.container.start()
    console.log(`Container started for sandbox ${this.sandboxId}`)
  }

  // Initialize the container environment
  async initialize(
    fileWatchCallback: ((files: (TFolder | TFile)[]) => void) | undefined
  ) {
    await lockManager.acquireLock(this.sandboxId, async () => {
      await this.ensureContainerExists()
    })

    if (!this.container) {
      throw new Error("Failed to create Docker container")
    }

    // Terminal
    if (!this.terminalManager) {
      this.terminalManager = new TerminalManager(this.container)
      console.log(`Terminal manager set up for ${this.sandboxId}`)
    }

    // File manager
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
    // Close all terminals
    await this.terminalManager?.closeAllTerminals()
    this.terminalManager = null

    // Stop watchers
    await this.fileManager?.closeWatchers()
    this.fileManager = null

    // Optionally shut down the container to free resources
    if (this.container) {
      try {
        await this.container.stop()
        await this.container.remove({ force: true })
        console.log(`Stopped and removed container ${this.sandboxId}`)
      } catch (error) {
        console.error(`Error removing container ${this.sandboxId}:`, error)
      }
    }
    this.container = null
  }

  // Here are all the socket event handlers, including Dokku logic:
  handlers(connection: {
    userId: string
    isOwner: boolean
    socket: Socket
  }) {
    // Keep container alive if needed
    const handleHeartbeat = (_: any) => {
      console.log(`Heartbeat from sandbox ${this.sandboxId}`)
      // If you wanted a “timeout reset,” you can do so here.
    }

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

    const handleMoveFile = ({ fileId, folderId }: any) => {
      return this.fileManager?.moveFile(fileId, folderId)
    }

    // *** Dokku-based events (unchanged) ***
    const handleListApps = async (_: any) => {
      if (!this.dokkuClient) {
        throw new Error("No Dokku client available.")
      }
      return {
        success: true,
        apps: await this.dokkuClient.listApps(),
      }
    }

    const handleGetAppCreatedAt = async ({ appName }: any) => {
      if (!this.dokkuClient) {
        throw new Error("No Dokku client available.")
      }
      return {
        success: true,
        createdAt: await this.dokkuClient.getAppCreatedAt(appName),
      }
    }

    const handleAppExists = async ({ appName }: any) => {
      if (!this.dokkuClient) {
        return {
          success: false,
        }
      }
      if (!this.dokkuClient.isConnected) {
        return {
          success: false,
        }
      }
      return {
        success: true,
        exists: await this.dokkuClient.appExists(appName),
      }
    }

    const handleDeploy = async (_: any) => {
      // This references the SecureGitClient, 
      // so we can push the project files to Dokku for deployment
      if (!this.gitClient) throw Error("No git client")
      if (!this.fileManager) throw Error("No file manager")
      await this.gitClient.pushFiles(
        await this.fileManager?.loadFileContent(),
        this.sandboxId
      )
      return { success: true }
    }

    // *** Create / rename / delete, etc. ***
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

    const handleDeleteFolder = ({ folderId }: any) => {
      return this.fileManager?.deleteFolder(folderId)
    }

    // *** Terminal management ***
    const handleCreateTerminal = async ({ id }: any) => {
      await lockManager.acquireLock(this.sandboxId, async () => {
        await this.terminalManager?.createTerminal(id, (output: string) => {
          connection.socket.emit("terminalResponse", {
            id,
            data: output,
          })
          // If you see a local port in the output, transform it to a preview
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

    // *** Download files as zip ***
    const handleDownloadFiles = async () => {
      if (!this.fileManager) throw Error("No file manager")
      const zipBase64 = await this.fileManager.getFilesForDownload()
      return { zipBlob: zipBase64 }
    }

    return {
      heartbeat: handleHeartbeat,
      getFile: handleGetFile,
      getFolder: handleGetFolder,
      saveFile: handleSaveFile,
      moveFile: handleMoveFile,

      // Dokku handlers:
      listApps: handleListApps,
      getAppCreatedAt: handleGetAppCreatedAt,
      getAppExists: handleAppExists,
      deploy: handleDeploy,

      createFile: handleCreateFile,
      createFolder: handleCreateFolder,
      renameFile: handleRenameFile,
      deleteFile: handleDeleteFile,
      deleteFolder: handleDeleteFolder,

      createTerminal: handleCreateTerminal,
      resizeTerminal: handleResizeTerminal,
      terminalData: handleTerminalData,
      closeTerminal: handleCloseTerminal,
      downloadFiles: handleDownloadFiles,
    }
  }
}
