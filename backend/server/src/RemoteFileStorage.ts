// /backend/server/src/RemoteFileStorage.ts
import * as dotenv from "dotenv"
import { R2Files } from "./types"

dotenv.config()

export const RemoteFileStorage = {
  async getSandboxPaths(id: string): Promise<string[]> {
    const res = await fetch(
      `${process.env.STORAGE_WORKER_URL}/api?sandboxId=${id}`,
      {
        headers: { Authorization: `${process.env.WORKERS_KEY}` },
      },
    )
    const data: R2Files = await res.json()
    return data.objects.map((obj) => obj.key)
  },

  async getFolder(folderId: string): Promise<string[]> {
    const res = await fetch(
      `${process.env.STORAGE_WORKER_URL}/api?folderId=${folderId}`,
      {
        headers: { Authorization: `${process.env.WORKERS_KEY}` },
      },
    )
    const data: R2Files = await res.json()
    return data.objects.map((obj) => obj.key)
  },

  async fetchFileContent(fileId: string): Promise<string> {
    try {
      const fileRes = await fetch(
        `${process.env.STORAGE_WORKER_URL}/api?fileId=${fileId}`,
        {
          headers: { Authorization: `${process.env.WORKERS_KEY}` },
        },
      )
      return await fileRes.text()
    } catch (error) {
      console.error("ERROR fetching file:", error)
      return ""
    }
  },

  async createFile(fileId: string): Promise<boolean> {
    const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.WORKERS_KEY}`,
      },
      body: JSON.stringify({ fileId }),
    })
    return res.ok
  },

  async renameFile(
    fileId: string,
    newFileId: string,
    data: string,
  ): Promise<boolean> {
    const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api/rename`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.WORKERS_KEY}`,
      },
      body: JSON.stringify({ fileId, newFileId, data }),
    })
    return res.ok
  },

  async saveFile(fileId: string, data: string): Promise<boolean> {
    const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.WORKERS_KEY}`,
      },
      body: JSON.stringify({ fileId, data }),
    })
    return res.ok
  },

  async deleteFile(fileId: string): Promise<boolean> {
    const res = await fetch(`${process.env.STORAGE_WORKER_URL}/api`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.WORKERS_KEY}`,
      },
      body: JSON.stringify({ fileId }),
    })
    return res.ok
  },

  async getProjectSize(id: string): Promise<number> {
    const res = await fetch(
      `${process.env.STORAGE_WORKER_URL}/api/size?sandboxId=${id}`,
      {
        headers: { Authorization: `${process.env.WORKERS_KEY}` },
      },
    )
    return (await res.json()).size
  },
}

export default RemoteFileStorage
