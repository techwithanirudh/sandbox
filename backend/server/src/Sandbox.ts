// /backend/server/src/Sandbox.ts
import { Socket } from 'socket.io'
import { DockerManager } from './DockerManager'
import { ContainerSession } from './ContainerSession'
import { CONTAINER_TIMEOUT } from './constants'
import { DokkuClient } from './DokkuClient'
import { FileManager } from './FileManager'
import { createFileRL, createFolderRL, deleteFileRL, renameFileRL, saveFileRL } from './ratelimit'
import { SecureGitClient } from './SecureGitClient'
import { TerminalManager } from './TerminalManager'
import { TFile, TFolder } from './types'
import { LockManager } from './utils'

// Decide Docker image from type
const imageMap: Record<string, string> = {
  vanillajs: 'gitwit-vanillajs',
  reactjs: 'gitwit-reactjs',
  nextjs: 'gitwit-nextjs',
  streamlit: 'gitwit-streamlit',
  php: 'gitwit-php',
}

const dockerManager = new DockerManager()
const lockManager = new LockManager()

export class Sandbox {
  sandboxId: string
  type: string
  fileManager: FileManager | null
  terminalManager: TerminalManager | null
  containerSession: ContainerSession | null

  dokkuClient: DokkuClient | null
  gitClient: SecureGitClient | null

  constructor(
    sandboxId: string,
    type: string,
    { dokkuClient, gitClient }: { dokkuClient: DokkuClient | null; gitClient: SecureGitClient | null }
  ) {
    this.sandboxId = sandboxId
    this.type = type
    this.fileManager = null
    this.terminalManager = null
    this.containerSession = null
    this.dokkuClient = dokkuClient
    this.gitClient = gitClient
  }

  // Create or re-init the container
  async initialize(fileWatchCallback?: (files: (TFolder | TFile)[]) => void) {
    await lockManager.acquireLock(this.sandboxId, async () => {
      // 1) Pick image
      const image = imageMap[this.type] || 'gitwit-universal'
      console.log(`[Sandbox] Using image: ${image} for sandbox: ${this.sandboxId}`)

      // 2) Create container
      const container = await dockerManager.createContainer(this.sandboxId, {
        Image: image,
        Cmd: ['tail', '-f', '/dev/null'], // keep alive
        Tty: true
      })

      // 3) Make ContainerSession
      this.containerSession = new ContainerSession(container, this.sandboxId, CONTAINER_TIMEOUT)
    })

    if (!this.containerSession) throw new Error('No container session!')

    // If you want watchers, you can call:
    // this.containerSession.startWatcher('/workspace/data', (line) => { ... })

    // Create or re-init FileManager
    if (!this.fileManager) {
      this.fileManager = new FileManager(
        this.sandboxId,
        this.containerSession['container'], // pass the raw Container
        fileWatchCallback ?? null
      )
      await this.fileManager.initialize()
    }

    // Create or re-init TerminalManager
    if (!this.terminalManager) {
      this.terminalManager = new TerminalManager(
        this.containerSession['container'] // raw Container
      )
    }
  }

  // Keep container alive
  heartbeat() {
    this.containerSession?.resetTimeout(async () => {
      console.log(`[Sandbox] Container ${this.sandboxId} timed out, removing...`)
      await dockerManager.removeContainer(this.sandboxId)
    })
  }

  // Shut everything down
  async disconnect() {
    console.log(`[Sandbox] Disconnecting sandbox ${this.sandboxId}`)
    // close watchers
    this.containerSession?.stopWatchers()
    // close terminals
    await this.terminalManager?.closeAllTerminals()
    // remove container
    await dockerManager.removeContainer(this.sandboxId)
    // cleanup
    this.containerSession?.cleanup()
    this.containerSession = null
    this.fileManager = null
    this.terminalManager = null
  }

  // Socket event handlers
  handlers(connection: { userId: string; isOwner: boolean; socket: Socket }) {
    const handleHeartbeat = () => {
      this.heartbeat()
    }

    const handleGetFile = ({ fileId }: any) => {
      return this.fileManager?.getFile(fileId)
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
      // implement in your FileManager (like you had)
      return { success: true }
    }

    const handleCreateFolder = async ({ name }: any) => {
      await createFolderRL.consume(connection.userId, 1)
      // implement in your FileManager
      return { success: true }
    }

    const handleRenameFile = async ({ fileId, newName }: any) => {
      await renameFileRL.consume(connection.userId, 1)
      // implement rename logic
      return
    }

    const handleDeleteFile = async ({ fileId }: any) => {
      await deleteFileRL.consume(connection.userId, 1)
      // implement delete logic
      return
    }

    const handleDeleteFolder = async ({ folderId }: any) => {
      // implement
      return
    }

    // Example: create a terminal
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

    // Example: handle Dokku or Git
    const handleListApps = async () => {
      if (!this.dokkuClient) throw new Error('No Dokku client')
      return { success: true, apps: await this.dokkuClient.listApps() }
    }

    // Deploy
    const handleDeploy = async () => {
      if (!this.gitClient) throw new Error('No git client')
      if (!this.fileManager) throw new Error('No file manager')
      await this.gitClient.pushFiles(
        this.fileManager.fileData,
        this.sandboxId
      )
      return { success: true }
    }

    return {
      heartbeat: handleHeartbeat,
      getFile: handleGetFile,
      saveFile: handleSaveFile,
      moveFile: handleMoveFile,
      createFile: handleCreateFile,
      createFolder: handleCreateFolder,
      renameFile: handleRenameFile,
      deleteFile: handleDeleteFile,
      deleteFolder: handleDeleteFolder,
      createTerminal: handleCreateTerminal,
      resizeTerminal: handleResizeTerminal,
      terminalData: handleTerminalData,
      closeTerminal: handleCloseTerminal,
      listApps: handleListApps,
      deploy: handleDeploy,
    }
  }
}
