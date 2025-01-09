// /backend/server/src/Sandbox.ts
import { Socket } from "socket.io"
import { DockerManager } from "./DockerManager"
import { ContainerSession } from "./ContainerSession"
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
import path from "path"

/**
 * Map the “type” (like 'reactjs') to Docker images.
 * Adjust to your naming scheme.
 */
const imageMap: Record<string, string> = {
  vanillajs: "gitwit-vanillajs",
  reactjs: "gitwit-reactjs",
  nextjs: "gitwit-nextjs",
  streamlit: "gitwit-streamlit",
  php: "gitwit-php",
  default: "gitwit-universal",
}

const dockerManager = new DockerManager()
const lockManager = new LockManager()

export class Sandbox {
  sandboxId: string
  type: string

  // Docker-based container logic
  containerSession: ContainerSession | null

  // Additional managers/clients
  fileManager: FileManager | null
  terminalManager: TerminalManager | null
  dokkuClient: DokkuClient | null
  gitClient: SecureGitClient | null

  constructor(
    sandboxId: string,
    type: string,
    {
      dokkuClient,
      gitClient,
    }: { dokkuClient: DokkuClient | null; gitClient: SecureGitClient | null },
  ) {
    this.sandboxId = sandboxId
    this.type = type

    this.containerSession = null
    this.fileManager = null
    this.terminalManager = null

    this.dokkuClient = dokkuClient
    this.gitClient = gitClient
  }

  /**
   * Initialize (or re-init) the Docker container & managers
   */
  async initialize(fileWatchCallback?: (files: (TFolder | TFile)[]) => void) {
    await lockManager.acquireLock(this.sandboxId, async () => {
      // Decide image
      const image = imageMap[this.type] || imageMap.default
      console.log(
        `[Sandbox] Using image: ${image} for sandbox: ${this.sandboxId}`,
      )

      // Create container
      const container = await dockerManager.createContainer(this.sandboxId, {
        Image: image,
        Cmd: ["tail", "-f", "/dev/null"],
        Tty: true,
      })

      // Create session
      this.containerSession = new ContainerSession(
        container,
        this.sandboxId,
        CONTAINER_TIMEOUT,
      )
    })

    if (!this.containerSession) {
      throw new Error("[Sandbox] Container session not created!")
    }

    // FileManager
    if (!this.fileManager) {
      this.fileManager = new FileManager(
        this.sandboxId,
        this.containerSession["container"],
        fileWatchCallback ?? null,
      )
      await this.fileManager.initialize()
    }

    // TerminalManager
    if (!this.terminalManager) {
      this.terminalManager = new TerminalManager(
        this.containerSession["container"],
      )
    }

    console.log(`[Sandbox] Sandbox ${this.sandboxId} initialized successfully.`)
  }

  /**
   * Extend the container’s life on each heartbeat. If it times out, we remove it from Docker.
   */
  heartbeat() {
    this.containerSession?.resetTimeout(async () => {
      console.log(
        `[Sandbox] Container ${this.sandboxId} timed out; removing...`,
      )
      await dockerManager.removeContainer(this.sandboxId)
    })
  }

  /**
   * Called when the “owner” truly disconnects. Shuts down watchers, terminals, and container.
   */
  async disconnect() {
    console.log(`[Sandbox] Disconnecting sandbox ${this.sandboxId}...`)
    this.containerSession?.stopWatchers()
    await this.terminalManager?.closeAllTerminals()
    await dockerManager.removeContainer(this.sandboxId)
    this.containerSession?.cleanup()

    this.containerSession = null
    this.fileManager = null
    this.terminalManager = null
  }

  /**
   * Handlers for socket events. Return an object with function per event name.
   */
  handlers(connection: { userId: string; isOwner: boolean; socket: Socket }) {
    // Basic heartbeat
    const handleHeartbeat = () => {
      this.heartbeat()
    }

    // --- File Ops ---
    const handleGetFile = ({ fileId }: any) => {
      return this.fileManager?.getFile(fileId)
    }

    const handleGetFolder = ({ folderId }: any) => {
      // For example, in your old code you had `FileManager.getFolder()`.
      return this.fileManager?.getFolder(folderId)
    }

    const handleSaveFile = async ({ fileId, body }: any) => {
      await saveFileRL.consume(connection.userId, 1)
      return this.fileManager?.saveFile(fileId, body)
    }

    const handleMoveFile = ({ fileId, folderId }: any) => {
      return this.fileManager?.moveFile(fileId, folderId)
    }

    const handleCreateFile = async ({ name }: any) => {
      await createFileRL.consume(connection.userId, 1)
      const success = await this.fileManager?.createFile(name)
      return { success }
    }

    const handleCreateFolder = async ({ name }: any) => {
      await createFolderRL.consume(connection.userId, 1)
      // If you have `fileManager.createFolder(...)`
      await this.fileManager?.createFolder(name)
      return { success: true }
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
      // If you have a method to do this
      return this.fileManager?.deleteFolder(folderId)
    }

    /**
     * Example: handleDownloadFiles
     * You might do something like creating a Zip from the container’s files or from remote.
     * If you already have a method in FileManager (like `getFilesForDownload()`), just call it.
     */
    const handleDownloadFiles = async () => {
      if (!this.fileManager) throw new Error("[Sandbox] No file manager")
      const zipBase64 = await this.fileManager.getFilesForDownload()
      return { zipBlob: zipBase64 }
    }

    // --- Terminal / PTY ---
    const handleCreateTerminal = async ({ id }: any) => {
      await lockManager.acquireLock(this.sandboxId, async () => {
        await this.terminalManager?.createTerminal(id, (output: string) => {
          connection.socket.emit("terminalResponse", { id, data: output })
        })
      })
    }

    const handleResizeTerminal = ({ id, cols, rows }: any) => {
      this.terminalManager?.resizeTerminal(id, { cols, rows })
    }

    const handleTerminalData = ({ id, data }: any) => {
      return this.terminalManager?.sendTerminalData(id, data)
    }

    const handleCloseTerminal = ({ id }: any) => {
      return this.terminalManager?.closeTerminal(id)
    }

    // --- Dokku stuff ---
    const handleListApps = async () => {
      if (!this.dokkuClient) throw new Error("No Dokku client.")
      return { success: true, apps: await this.dokkuClient.listApps() }
    }

    const handleGetAppCreatedAt = async ({ appName }: any) => {
      if (!this.dokkuClient) throw new Error("No Dokku client.")
      const createdAt = await this.dokkuClient.getAppCreatedAt(appName)
      return { success: true, createdAt }
    }

    const handleAppExists = async ({ appName }: any) => {
      if (!this.dokkuClient) return { success: false }
      if (!this.dokkuClient.isConnected) return { success: false }
      const exists = await this.dokkuClient.appExists(appName)
      return { success: true, exists }
    }

    // --- Deployment via SecureGitClient ---
    const handleDeploy = async () => {
      if (!this.gitClient) throw new Error("No git client")
      if (!this.fileManager) throw new Error("No file manager")
      // gather file data from fileManager
      const fileData = this.fileManager.fileData
      await this.gitClient.pushFiles(fileData, this.sandboxId)
      return { success: true }
    }

    // Return them as an object. The socket logic in `index.ts` uses these.
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
      downloadFiles: handleDownloadFiles, // <-- ADDED
      listApps: handleListApps, // <-- ADDED
      getAppCreatedAt: handleGetAppCreatedAt, // <-- ADDED
      getAppExists: handleAppExists, // <-- ADDED
      deploy: handleDeploy, // <-- ADDED

      createTerminal: handleCreateTerminal,
      resizeTerminal: handleResizeTerminal,
      terminalData: handleTerminalData,
      closeTerminal: handleCloseTerminal,
    }
  }
}
