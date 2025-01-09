// /backend/server/src/SecureGitClient.ts
import fs from "fs"
import os from "os"
import path from "path"
import simpleGit, { SimpleGit } from "simple-git"

export type FileData = {
  id: string
  data: string
}

export class SecureGitClient {
  private gitUrl: string
  private sshKeyPath: string

  constructor(gitUrl: string, sshKeyPath: string) {
    this.gitUrl = gitUrl
    this.sshKeyPath = sshKeyPath
  }

  async pushFiles(fileData: FileData[], repository: string): Promise<void> {
    let tempDir: string | undefined
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-push-'))
      console.log(`Temp dir: ${tempDir}`)

      for (const { id, data } of fileData) {
        const filePath = path.join(tempDir, id)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, data)
      }

      const git: SimpleGit = simpleGit(tempDir, {
        config: [
          `core.sshCommand=ssh -i ${this.sshKeyPath} -o IdentitiesOnly=yes`
        ]
      }).outputHandler((_command, stdout, stderr) => {
        stdout.pipe(process.stdout)
        stderr.pipe(process.stderr)
      })

      await git.init()
      await git.addRemote('origin', `${this.gitUrl}:${repository}`)

      for (const f of fileData) {
        const p = f.id.startsWith('/') ? f.id.slice(1) : f.id
        await git.add(p)
      }

      await git.commit('Add files via SecureGitClient')
      await git.push('origin', 'master', { '--force': null })
      console.log('Pushed files to the repository')

      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch (error) {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
      console.error('[SecureGitClient] Error pushing files:', error)
      throw error
    }
  }
}
