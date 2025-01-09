// /backend/server/src/Sandbox.ts

import { Socket } from 'socket.io'
import { DockerManager } from './DockerManager'          // or your own Docker manager
import { FileManager } from './FileManager'              // the new FileManager with watchers
import { TerminalManager } from './TerminalManager'
import { DokkuClient } from './DokkuClient'
import { SecureGitClient } from './SecureGitClient'
import { TFile, TFolder } from './types'
import { 
  createFileRL,
  createFolderRL,
  deleteFileRL,
  renameFileRL,
  saveFileRL,
} from './ratelimit'
import { LockManager } from './utils'
import { CONTAINER_TIMEOUT } from './constants'

// If you have multiple images depending on 'type', define a map:
const imageMap: Record<string, string> = {
  vanillajs: 'gitwit-vanillajs',
  reactjs: 'gitwit-reactjs',
  nextjs: 'gitwit-nextjs',
  streamlit: 'gitwit-streamlit',
  php: 'gitwit-php',
  default: 'gitwit-universal',
}

// We'll use a single DockerManager instance for simplicity
const dockerManager = new DockerManager()
const lockManager = new LockManager()

export class Sandbox {
  // Basic properties
  sandboxId: string
  type: string

  // Docker container references
  // (If you had a ContainerSession, you could store that. 
  // For now, we'll do something simpler.)
  containerId: string | null = null

  // Our watchers-based FileManager
  fileManager: FileManager | null = null
  // Optional: Terminal manager
  terminalManager: TerminalManager | null = null

  // Extra clients
  dokkuClient: DokkuClient | null
  gitClient: SecureGitClient | null

  constructor(
    sandboxId: string,
    type: string,
    {
      dokkuClient,
      gitClient,
    }: {
      dokkuClient: DokkuClient | null
      gitClient: SecureGitClient | null
    }
  ) {
    this.sandboxId = sandboxId
    this.type = type
    this.dokkuClient = dokkuClient
    this.gitClient = gitClient
  }

  /**
   * Initialize or re-initialize the sandbox:
   * - Create (or recreate) the Docker container
   * - Create a FileManager for watchers-based R2 sync
   * - (Optional) create a TerminalManager
   */
  async initialize(
    fileWatchCallback?: (files: (TFolder | TFile)[]) => void
  ) {
    await lockManager.acquireLock(this.sandboxId, async () => {
      // 1) Pick an image
      const image = imageMap[this.type] || imageMap.default
      console.log(`[Sandbox] Using image: ${image} for sandbox: ${this.sandboxId}`)

      // 2) Create or recreate container with DockerManager
      //    We'll store under the same ID as sandboxId for convenience
      const container = await dockerManager.createContainer(this.sandboxId, {
        Image: image,
        Cmd: ['tail', '-f', '/dev/null'], // keep container alive
        Tty: true,
      })
      this.containerId = container.id

      console.log(`[Sandbox] Created container for sandbox ${this.sandboxId}, containerId=${container.id}`)
    })

    // 3) Now set up FileManager (which starts watchers)
    if (!this.fileManager) {
      const container = dockerManager.getContainer(this.sandboxId)
      if (!container) {
        throw new Error(`[Sandbox] Could not find container after creation.`)
      }

      this.fileManager = new FileManager(
        this.sandboxId,
        container,
        fileWatchCallback ?? null
      )
      await this.fileManager.initialize()
    }

    // 4) TerminalManager if needed
    if (!this.terminalManager) {
      const container = dockerManager.getContainer(this.sandboxId)
      if (!container) {
        throw new Error(`[Sandbox] Could not find container to init TerminalManager.`)
      }
      this.terminalManager = new TerminalManager(container)
    }

    console.log(`[Sandbox] Sandbox ${this.sandboxId} is fully initialized.`)
  }

  /**
   * A heartbeat approach if you want to forcibly remove container after some idle time, etc.
   * If you want to implement timeouts, do so here, or in your main index code.
   */
  heartbeat() {
    // (You could track a last-heard timestamp here or something else.)
    // Example:
    // if (someTimeout logic)...

    // For now, we do nothing. If you want, you can do:
    // setTimeout(() => dockerManager.removeContainer(this.sandboxId), 120_000)
  }

  /**
   * Disconnect: close watchers, kill terminals, remove container if desired
   */
  async disconnect() {
    console.log(`[Sandbox] Disconnecting sandbox ${this.sandboxId}...`)
    // 1) Close watchers
    await this.fileManager?.closeWatchers()

    // 2) Close terminals
    await this.terminalManager?.closeAllTerminals()

    // 3) Remove container if you want
    await dockerManager.removeContainer(this.sandboxId)
    console.log(`[Sandbox] Container removed for sandbox ${this.sandboxId}`)

    // Clear references
    this.fileManager = null
    this.terminalManager = null
    this.containerId = null
  }

  /**
   * Returns an object with event handlers for socket usage.
   */
  handlers(connection: { userId: string; isOwner: boolean; socket: Socket }) {
    // Use your original approach of returning a map:
    const handleHeartbeat = () => {
      this.heartbeat()
    }

    // --- FILES ---
    const handleGetFile = ({ fileId }: any) => {
      return this.fileManager?.getFile(fileId)
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

    const handleGetFolder = ({ folderId }: any) => {
      return this.fileManager?.getFolder(folderId)
    }

    const handleDownloadFiles = async () => {
      if (!this.fileManager) throw new Error('No file manager')
      const zipBase64 = await this.fileManager.getFilesForDownload()
      return { zipBlob: zipBase64 }
    }

    // --- TERMINALS ---
    const handleCreateTerminal = async ({ id }: any) => {
      await lockManager.acquireLock(this.sandboxId, async () => {
        await this.terminalManager?.createTerminal(id, (output: string) => {
          connection.socket.emit('terminalResponse', { id, data: output })
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

    // --- DOKKU STUFF ---
    const handleListApps = async () => {
      if (!this.dokkuClient) throw new Error('No Dokku client available')
      return { success: true, apps: await this.dokkuClient.listApps() }
    }

    const handleGetAppCreatedAt = async ({ appName }: any) => {
      if (!this.dokkuClient) throw new Error('No Dokku client available')
      const createdAt = await this.dokkuClient.getAppCreatedAt(appName)
      return { success: true, createdAt }
    }

    const handleAppExists = async ({ appName }: any) => {
      if (!this.dokkuClient) return { success: false }
      if (!this.dokkuClient.isConnected) return { success: false }
      const exists = await this.dokkuClient.appExists(appName)
      return { success: true, exists }
    }

    // --- DEPLOY VIA GIT ---
    const handleDeploy = async () => {
      if (!this.gitClient) throw new Error('No git client')
      if (!this.fileManager) throw new Error('No file manager')
      await this.gitClient.pushFiles(this.fileManager.fileData, this.sandboxId)
      return { success: true }
    }

    // Return the event handlers map
    return {
      // Some calls
      heartbeat: handleHeartbeat,

      // File ops
      getFile: handleGetFile,
      saveFile: handleSaveFile,
      moveFile: handleMoveFile,
      createFile: handleCreateFile,
      createFolder: handleCreateFolder,
      renameFile: handleRenameFile,
      deleteFile: handleDeleteFile,
      deleteFolder: handleDeleteFolder,
      getFolder: handleGetFolder,
      downloadFiles: handleDownloadFiles,

      // Terminal ops
      createTerminal: handleCreateTerminal,
      resizeTerminal: handleResizeTerminal,
      terminalData: handleTerminalData,
      closeTerminal: handleCloseTerminal,

      // Dokku ops
      listApps: handleListApps,
      getAppCreatedAt: handleGetAppCreatedAt,
      getAppExists: handleAppExists,
      deploy: handleDeploy,
    }
  }
}
