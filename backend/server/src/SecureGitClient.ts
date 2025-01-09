// /backend/server/src/SecureGitClient.ts
import fs from "fs"
import os from "os"
import path from "path"
import simpleGit, { SimpleGit } from "simple-git"
import logger from "./logger"

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
      tempDir = fs.mkdtempSync(path.posix.join(os.tmpdir(), "git-push-"))
      logger.info(`Temporary directory created: ${tempDir}`)

      logger.info(`Writing ${fileData.length} files.`)
      for (const { id, data } of fileData) {
        const filePath = path.posix.join(tempDir, id)
        const dirPath = path.dirname(filePath)

        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true })
        }
        fs.writeFileSync(filePath, data)
      }

      const git: SimpleGit = simpleGit(tempDir, {
        config: [
          `core.sshCommand=ssh -i ${this.sshKeyPath} -o IdentitiesOnly=yes`,
        ],
      }).outputHandler((_command, stdout, stderr) => {
        stdout.pipe(process.stdout)
        stderr.pipe(process.stderr)
      })

      await git.init()
      await git.addRemote("origin", `${this.gitUrl}:${repository}`)

      for (const { id } of fileData) {
        await git.add(id.startsWith("/") ? id.slice(1) : id)
      }

      await git.commit("Add files.")
      await git.push("origin", "master", { "--force": null })

      logger.info("Files successfully pushed to the repository")
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true })
        logger.info(`Temporary directory removed: ${tempDir}`)
      }
    } catch (error) {
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true })
        logger.info(`Temporary directory removed: ${tempDir}`)
      }
      logger.error(`Error pushing files to the repository: ${error}`)
      throw error
    }
  }
}
