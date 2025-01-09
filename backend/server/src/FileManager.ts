// /backend/server/src/FileManager.ts
import path from 'path'
import { Container } from 'dockerode'
import tar from 'tar-stream'
import { TFile, TFileData, TFolder } from './types'
import RemoteFileStorage from './RemoteFileStorage'
import { MAX_BODY_SIZE } from './ratelimit'
import { generateFileStructure } from './utils-filetree'

/**
 * We'll store all project files in /workspace/data inside the container.
 */
const PROJECT_DIR = '/workspace/data'

export class FileManager {
  private sandboxId: string
  private container: Container
  private refreshFileList: ((files: (TFolder | TFile)[]) => void) | null

  public files: (TFolder | TFile)[]
  public fileData: TFileData[]

  constructor(
    sandboxId: string,
    container: Container,
    refreshFileList: ((files: (TFolder | TFile)[]) => void) | null
  ) {
    this.sandboxId = sandboxId
    this.container = container
    this.refreshFileList = refreshFileList

    this.files = []
    this.fileData = []
  }

  /**
   * Initialize FileManager: 
   * - Sync remote -> container
   * - Load container's file structure -> memory
   */
  async initialize() {
    console.log(`[FileManager] Initializing for sandbox ${this.sandboxId}`)
    try {
      // 1) Pull file paths from remote, generate structure
      await this.updateFileStructure()

      // 2) Pull actual file data from remote
      await this.updateFileData()

      // 3) Copy that data into the container
      await this.syncFilesIntoContainer()

      // 4) Now load the local file structure from container
      await this.loadLocalFiles()
      console.log(`[FileManager] Done initializing for sandbox ${this.sandboxId}`)
    } catch (error) {
      console.error(`[FileManager] Error initializing:`, error)
      throw error
    }
  }

  // ----------------------------------------------------------------
  //  Remote -> Local
  // ----------------------------------------------------------------

  private async updateFileStructure() {
    // fetch all remote object keys for this sandbox
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    // strip "projects/<sandboxId>/" so we get relative paths
    const localPaths = remotePaths.map(r => r.replace(`projects/${this.sandboxId}/`, ''))
    this.files = generateFileStructure(localPaths)
    return this.files
  }

  private async updateFileData() {
    // same approach: get all remotePaths, fetch content
    const remotePaths = await RemoteFileStorage.getSandboxPaths(this.sandboxId)
    const localPaths = remotePaths.map(r => r.replace(`projects/${this.sandboxId}/`, ''))

    const results: TFileData[] = []
    for (const p of localPaths) {
      if (!p || p.endsWith('/')) continue
      const content = await RemoteFileStorage.fetchFileContent(`projects/${this.sandboxId}/${p}`)
      results.push({ id: p, data: content })
    }
    this.fileData = results
    return this.fileData
  }

  /**
   * Copy fileData into container.
   */
  private async syncFilesIntoContainer() {
    for (const file of this.fileData) {
      const containerPath = path.posix.join(PROJECT_DIR, file.id)
      await this.writeToContainer(containerPath, file.data)
    }
  }

  /**
   * Load local files from container, update this.files
   */
  private async loadLocalFiles() {
    const { stdout, stderr } = await this.execInContainer(`find "${PROJECT_DIR}" -type f`)
    if (stderr) {
      console.error('[FileManager] Error listing files in container:', stderr)
      return
    }

    const localPaths = stdout
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean)
      .map(fp => path.posix.relative(PROJECT_DIR, fp))

    this.files = generateFileStructure(localPaths)
  }

  /**
   * Helper: run a command in the container and get stdout/stderr
   */
  private async execInContainer(cmd: string): Promise<{ stdout: string; stderr: string }> {
    const exec = await this.container.exec({
      Cmd: ['bash', '-c', cmd],
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = await exec.start({})
    let stdout = ''
    let stderr = ''

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
      stream.on('end', resolve)
      stream.on('error', reject)
    })
    return { stdout, stderr }
  }

  /**
   * Helper: Write a single file to container via tar-stream
   */
  private async writeToContainer(containerPath: string, data: string) {
    try {
      const pack = tar.pack()
      // strip leading slash if needed
      const relPath = containerPath.startsWith('/')
        ? containerPath.slice(1)
        : containerPath

      pack.entry({ name: relPath }, data)
      pack.finalize()

      await this.container.putArchive(pack, { path: '/' })
    } catch (error) {
      console.error(`[FileManager] Error writing file to container at ${containerPath}:`, error)
      throw error
    }
  }

  // ----------------------------------------------------------------
  //  Public API Methods
  // ----------------------------------------------------------------

  /**
   * Return contents of a file from container
   */
  public async getFile(fileId: string): Promise<string | undefined> {
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    const { stdout, stderr } = await this.execInContainer(`cat "${containerPath}"`)
    if (stderr) {
      console.error(`[FileManager] Error reading file ${fileId}: ${stderr}`)
      return undefined
    }
    return stdout
  }

  /**
   * Save a file: update remote & container
   */
  public async saveFile(fileId: string, body: string): Promise<void> {
    if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_SIZE) {
      throw new Error('File size too large.')
    }

    // 1) Save to remote
    await RemoteFileStorage.saveFile(`projects/${this.sandboxId}/${fileId}`, body)

    // 2) Update in-memory
    let fileEntry = this.fileData.find(f => f.id === fileId)
    if (fileEntry) {
      fileEntry.data = body
    } else {
      fileEntry = { id: fileId, data: body }
      this.fileData.push(fileEntry)
    }

    // 3) Write to container
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    await this.writeToContainer(containerPath, body)

    // Optionally update the file structure
    this.refreshFileList?.(this.files)
  }

  /**
   * Move a file from fileId => folderId (like old logic).
   */
  public async moveFile(fileId: string, folderId: string) {
    // new path
    const parts = fileId.split('/')
    const newFileId = path.posix.join(folderId, parts[parts.length - 1])

    // move in container
    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.execInContainer(
      `mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`
    )

    // rename in our in-memory data
    const dataEntry = this.fileData.find(f => f.id === fileId)
    if (dataEntry) {
      dataEntry.id = newFileId
      // rename in remote
      await RemoteFileStorage.renameFile(
        `projects/${this.sandboxId}/${fileId}`,
        `projects/${this.sandboxId}/${newFileId}`,
        dataEntry.data,
      )
    }

    // update file structure
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Create a new, empty file
   */
  public async createFile(name: string): Promise<boolean> {
    // you might want to check total project size
    const size = await RemoteFileStorage.getProjectSize(this.sandboxId)
    if (size > 200 * 1024 * 1024) {
      throw new Error('Project size exceeded. Please delete some files.')
    }

    // create empty file in container
    const fileId = `/${name}`
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    await this.execInContainer(`mkdir -p "$(dirname "${containerPath}")" && touch "${containerPath}"`)

    // add to remote
    await RemoteFileStorage.createFile(`projects/${this.sandboxId}${fileId}`)

    // update local references
    this.fileData.push({ id: name, data: '' })
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
    return true
  }

  /**
   * Rename a file within the same folder, or possibly newName
   */
  public async renameFile(fileId: string, newName: string): Promise<void> {
    const dataEntry = this.fileData.find(f => f.id === fileId)
    if (!dataEntry) return

    // figure new path
    const parts = fileId.split('/')
    parts[parts.length - 1] = newName
    const newFileId = parts.join('/')

    // container ops
    const oldPath = path.posix.join(PROJECT_DIR, fileId)
    const newPath = path.posix.join(PROJECT_DIR, newFileId)
    await this.execInContainer(`mkdir -p "$(dirname "${newPath}")" && mv "${oldPath}" "${newPath}"`)

    // rename in remote
    await RemoteFileStorage.renameFile(
      `projects/${this.sandboxId}/${fileId}`,
      `projects/${this.sandboxId}/${newFileId}`,
      dataEntry.data
    )
    dataEntry.id = newFileId

    // reload structure
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Delete a file from container & remote
   */
  public async deleteFile(fileId: string) {
    const dataEntry = this.fileData.find(f => f.id === fileId)
    if (!dataEntry) {
      console.warn(`[FileManager] File ${fileId} not found in fileData, but deleting anyway`)
    }

    // remove from container
    const containerPath = path.posix.join(PROJECT_DIR, fileId)
    await this.execInContainer(`rm -f "${containerPath}"`)

    // remove from remote
    await RemoteFileStorage.deleteFile(`projects/${this.sandboxId}/${fileId}`)

    // update local data
    this.fileData = this.fileData.filter(f => f.id !== fileId)

    // reload container file list & notify
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }

  /**
   * Delete a folder recursively
   */
  public async deleteFolder(folderId: string) {
    const remotePaths = await RemoteFileStorage.getFolder(`projects/${this.sandboxId}/${folderId}`)
    // remotePaths are full keys like "projects/<sandboxId>/<folderId>/something..."
    // We remove them from container & remote
    for (const fileKey of remotePaths) {
      const containerPath = fileKey.replace(`projects/${this.sandboxId}/`, PROJECT_DIR + '/')
      await this.execInContainer(`rm -rf "${containerPath}"`)
      await RemoteFileStorage.deleteFile(fileKey)
      this.fileData = this.fileData.filter(f => `projects/${this.sandboxId}/${f.id}` !== fileKey)
    }

    // reload
    await this.loadLocalFiles()
    this.refreshFileList?.(this.files)
  }
}
