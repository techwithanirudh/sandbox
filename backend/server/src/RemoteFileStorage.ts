// /backend/server/src/RemoteFileStorage.ts
import * as dotenv from "dotenv"
import { R2Files } from "./types"

dotenv.config()

export const RemoteFileStorage = {
  getSandboxPaths: async (id: string) => {
    try {
      console.log(`Fetching sandbox paths for sandbox ID: ${id}`)
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
      console.log(`Fetched ${data.objects.length} paths from R2 for sandbox ID: ${id}`)
      return data.objects.map((obj) => obj.key)
    } catch (error) {
      console.error(`Error in getSandboxPaths for sandbox ID ${id}:`, error)
      throw error
    }
  },

  getFolder: async (folderId: string) => {
    try {
      console.log(`Fetching folder paths for folder ID: ${folderId}`)
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
      console.log(`Fetched ${data.objects.length} paths from R2 for folder ID: ${folderId}`)
      return data.objects.map((obj) => obj.key)
    } catch (error) {
      console.error(`Error in getFolder for folder ID ${folderId}:`, error)
      throw error
    }
  },

  fetchFileContent: async (fileId: string): Promise<string> => {
    try {
      console.log(`Fetching content for file ID: ${fileId}`)
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
      console.log(`Fetched content for file ID ${fileId}, length: ${content.length}`)
      return content
    } catch (error) {
      console.error(`ERROR fetching file ${fileId}:`, error)
      return ""
    }
  },

  createFile: async (fileId: string) => {
    try {
      console.log(`Creating file in R2: ${fileId}`)
      const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `${process.env.WORKERS_KEY}`,
        },
        body: JSON.stringify({ fileId }),
      })
      if (!res.ok) {
        throw new Error(`Failed to create file: ${res.statusText}`)
      }
      console.log(`File created in R2: ${fileId}`)
      return res.ok
    } catch (error) {
      console.error(`Error creating file ${fileId}:`, error)
      return false
    }
  },

  renameFile: async (fileId: string, newFileId: string, data: string) => {
    try {
      console.log(`Renaming file from ${fileId} to ${newFileId} in R2`)
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
      console.log(`File renamed from ${fileId} to ${newFileId} in R2`)
      return res.ok
    } catch (error) {
      console.error(`Error renaming file from ${fileId} to ${newFileId}:`, error)
      return false
    }
  },

  saveFile: async (fileId: string, data: string) => {
    try {
      console.log(`Saving file ${fileId} to R2`)
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
      console.log(`File ${fileId} saved to R2 successfully`)
      return res.ok
    } catch (error) {
      console.error(`Error saving file ${fileId}:`, error)
      return false
    }
  },

  deleteFile: async (fileId: string) => {
    try {
      console.log(`Deleting file ${fileId} from R2`)
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
      console.log(`File ${fileId} deleted from R2 successfully`)
      return res.ok
    } catch (error) {
      console.error(`Error deleting file ${fileId}:`, error)
      return false
    }
  },

  getProjectSize: async (id: string) => {
    try {
      console.log(`Fetching project size for sandbox ID: ${id}`)
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
      console.log(`Fetched project size: ${size} bytes for sandbox ID: ${id}`)
      return size
    } catch (error) {
      console.error(`Error fetching project size for sandbox ID ${id}:`, error)
      return 0
    }
  },
}

export default RemoteFileStorage
