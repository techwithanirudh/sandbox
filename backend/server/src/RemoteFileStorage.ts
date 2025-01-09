// /backend/server/src/RemoteFileStorage.ts
import * as dotenv from "dotenv"
import { R2Files } from "./types"
import winston from "winston"

dotenv.config()

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

export const RemoteFileStorage = {
  /**
   * Fetch all file paths for a given sandbox ID from R2
   */
  getSandboxPaths: async (id: string): Promise<string[]> => {
    try {
      logger.info(`Fetching sandbox paths for sandbox ID: ${id}`)
      const res = await fetch(
        `${process.env.STORAGE_WORKER_URL}/api?sandboxId=${id}`,
        {
          headers: {
            Authorization: `${process.env.WORKERS_KEY}`,
          },
        }
      )
      if (!res.ok) {
        throw new Error(`Failed to fetch sandbox paths: ${res.statusText}`)
      }
      const data: R2Files = await res.json()
      logger.info(`Fetched ${data.objects.length} paths from R2 for sandbox ID: ${id}`)
      return data.objects.map((obj) => obj.key)
    } catch (error) {
      logger.error(`Error in getSandboxPaths for sandbox ID ${id}: ${error}`)
      throw error
    }
  },

  /**
   * Fetch all file paths within a specific folder from R2
   */
  getFolder: async (folderId: string): Promise<string[]> => {
    try {
      logger.info(`Fetching folder paths for folder ID: ${folderId}`)
      const res = await fetch(
        `${process.env.STORAGE_WORKER_URL}/api?folderId=${folderId}`,
        {
          headers: {
            Authorization: `${process.env.WORKERS_KEY}`,
          },
        }
      )
      if (!res.ok) {
        throw new Error(`Failed to fetch folder paths: ${res.statusText}`)
      }
      const data: R2Files = await res.json()
      logger.info(`Fetched ${data.objects.length} paths from R2 for folder ID: ${folderId}`)
      return data.objects.map((obj) => obj.key)
    } catch (error) {
      logger.error(`Error in getFolder for folder ID ${folderId}: ${error}`)
      throw error
    }
  },

  /**
   * Fetch the content of a specific file from R2
   */
  fetchFileContent: async (fileId: string): Promise<string> => {
    try {
      logger.info(`Fetching content for file ID: ${fileId}`)
      const fileRes = await fetch(
        `${process.env.STORAGE_WORKER_URL}/api?fileId=${fileId}`,
        {
          headers: {
            Authorization: `${process.env.WORKERS_KEY}`,
          },
        }
      )
      if (!fileRes.ok) {
        throw new Error(`Failed to fetch file content: ${fileRes.statusText}`)
      }
      const content = await fileRes.text()
      logger.info(`Fetched content for file ID ${fileId}, length: ${content.length}`)
      return content
    } catch (error) {
      logger.error(`Error fetching file ${fileId}: ${error}`)
      return ""
    }
  },

  /**
   * Create a new file in R2 (used for directories with .keep files)
   */
  createFile: async (fileId: string): Promise<boolean> => {
    try {
      logger.info(`Creating file in R2: ${fileId}`)
      const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.WORKERS_KEY}`,
        },
        body: JSON.stringify({ fileId, data: "" }), // Empty data for directories
      })
      if (!res.ok) {
        throw new Error(`Failed to create file: ${res.statusText}`)
      }
      logger.info(`File created in R2: ${fileId}`)
      return true
    } catch (error) {
      logger.error(`Error creating file ${fileId}: ${error}`)
      return false
    }
  },

  /**
   * Rename a file in R2
   */
  renameFile: async (fileId: string, newFileId: string, data: string): Promise<boolean> => {
    try {
      logger.info(`Renaming file from ${fileId} to ${newFileId} in R2`)
      const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api/rename`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.WORKERS_KEY}`,
        },
        body: JSON.stringify({ fileId, newFileId, data }),
      })
      if (!res.ok) {
        throw new Error(`Failed to rename file: ${res.statusText}`)
      }
      logger.info(`File renamed from ${fileId} to ${newFileId} in R2`)
      return true
    } catch (error) {
      logger.error(`Error renaming file from ${fileId} to ${newFileId}: ${error}`)
      return false
    }
  },

  /**
   * Save or update a file's content in R2
   */
  saveFile: async (fileId: string, data: string): Promise<boolean> => {
    try {
      logger.info(`Saving file ${fileId} to R2`)
      const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.WORKERS_KEY}`,
        },
        body: JSON.stringify({ fileId, data }),
      })
      if (!res.ok) {
        throw new Error(`Failed to save file: ${res.statusText}`)
      }
      logger.info(`File ${fileId} saved to R2 successfully`)
      return true
    } catch (error) {
      logger.error(`Error saving file ${fileId}: ${error}`)
      return false
    }
  },

  /**
   * Delete a file from R2
   */
  deleteFile: async (fileId: string): Promise<boolean> => {
    try {
      logger.info(`Deleting file ${fileId} from R2`)
      const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.WORKERS_KEY}`,
        },
        body: JSON.stringify({ fileId }),
      })
      if (!res.ok) {
        throw new Error(`Failed to delete file: ${res.statusText}`)
      }
      logger.info(`File ${fileId} deleted from R2 successfully`)
      return true
    } catch (error) {
      logger.error(`Error deleting file ${fileId}: ${error}`)
      return false
    }
  },

  /**
   * Get the total size of the project in R2
   */
  getProjectSize: async (id: string): Promise<number> => {
    try {
      logger.info(`Fetching project size for sandbox ID: ${id}`)
      const res = await fetch(
        `${process.env.STORAGE_WORKER_URL}/api/size?sandboxId=${id}`,
        {
          headers: {
            Authorization: `${process.env.WORKERS_KEY}`,
          },
        }
      )
      if (!res.ok) {
        throw new Error(`Failed to fetch project size: ${res.statusText}`)
      }
      const size = (await res.json()).size
      logger.info(`Fetched project size: ${size} bytes for sandbox ID: ${id}`)
      return size
    } catch (error) {
      logger.error(`Error fetching project size for sandbox ID ${id}: ${error}`)
      return 0
    }
  },
}

export default RemoteFileStorage
