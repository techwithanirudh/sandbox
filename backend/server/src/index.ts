// /backend/server/src/index.ts
import cors from "cors"
import dotenv from "dotenv"
import express, { Express } from "express"
import fs from "fs"
import { createServer } from "http"
import { Server, Socket } from "socket.io"
import Docker from "dockerode"

import { ConnectionManager } from "./ConnectionManager"
import { DokkuClient } from "./DokkuClient"
import { Sandbox } from "./Sandbox"
import { SecureGitClient } from "./SecureGitClient"
import { socketAuth } from "./socketAuth"
import { TFile, TFolder } from "./types"
import logger from "./logger"

export const handleErrors = (message: string, error: any, socket: Socket) => {
  logger.error(`${message} ${error}`)
  socket.emit("error", `${message} ${error.message ?? error}`)
}

process.on("uncaughtException", (error) => {
  logger.error(`Uncaught Exception: ${error}`)
})

process.on("unhandledRejection", (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`)
})

const connections = new ConnectionManager()
const sandboxes: Record<string, Sandbox> = {}

dotenv.config()

const app: Express = express()
const port = process.env.PORT || 4000
app.use(cors())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
})

io.use(socketAuth)

if (!process.env.DOKKU_HOST) {
  logger.warn("Environment variable DOKKU_HOST is not defined")
}
if (!process.env.DOKKU_USERNAME) {
  logger.warn("Environment variable DOKKU_USERNAME is not defined")
}
if (!process.env.DOKKU_KEY) {
  logger.warn("Environment variable DOKKU_KEY is not defined")
}

const dokkuClient =
  process.env.DOKKU_HOST &&
  process.env.DOKKU_KEY &&
  process.env.DOKKU_USERNAME
    ? new DokkuClient({
        host: process.env.DOKKU_HOST,
        username: process.env.DOKKU_USERNAME,
        privateKey: fs.readFileSync(process.env.DOKKU_KEY),
      })
    : null

if (dokkuClient) {
  dokkuClient.connect().catch((error) => {
    logger.error(`Failed to connect Dokku client: ${error}`)
  })
}

const gitClient =
  process.env.DOKKU_HOST && process.env.DOKKU_KEY
    ? new SecureGitClient(`dokku@${process.env.DOKKU_HOST}`, process.env.DOKKU_KEY)
    : null

const dockerClient = new Docker({
  socketPath: "/var/run/docker.sock",
})

io.on("connection", async (socket) => {
  try {
    const data = socket.data as {
      userId: string
      sandboxId: string
      isOwner: boolean
      type: string
    }
    logger.info(
      `User ${data.userId} connected to sandbox ${data.sandboxId} as ${
        data.isOwner ? "owner" : "collaborator"
      }`
    )

    connections.addConnectionForSandbox(socket, data.sandboxId, data.isOwner)
    logger.info(`Registered connection for sandbox ${data.sandboxId}`)

    if (!data.isOwner && !connections.ownerIsConnected(data.sandboxId)) {
      logger.warn(
        `Access denied for user ${data.userId} to sandbox ${data.sandboxId} because owner is not connected`
      )
      socket.emit("disableAccess", "The sandbox owner is not connected.")
      return
    }

    try {
      let sandbox = sandboxes[data.sandboxId]
      if (!sandbox) {
        sandbox = new Sandbox(data.sandboxId, data.type, {
          dockerClient,
          dokkuClient,
          gitClient,
        })
        sandboxes[data.sandboxId] = sandbox
        logger.info(`Created new Sandbox instance for sandbox ${data.sandboxId}`)
      } else {
        logger.info(`Reusing existing Sandbox instance for sandbox ${data.sandboxId}`)
      }

      const sendFileNotifications = (files: (TFolder | TFile)[]) => {
        connections
          .connectionsForSandbox(data.sandboxId)
          .forEach((connSocket: Socket) => {
            connSocket.emit("loaded", files)
          })
      }

      await sandbox.initialize(sendFileNotifications)
      logger.info(`Sandbox ${data.sandboxId} initialized`)

      socket.emit("loaded", sandbox.fileManager?.files)
      logger.info(
        `Sent initial file list to user ${data.userId} for sandbox ${data.sandboxId}`
      )

      const handlers = sandbox.handlers({
        userId: data.userId,
        isOwner: data.isOwner,
        socket,
      })

      Object.entries(handlers).forEach(([event, handler]) => {
        socket.on(event, async (options: any, callback?: (response: any) => void) => {
          try {
            logger.info(
              `Handling event "${event}" for user ${data.userId} in sandbox ${data.sandboxId}`
            )
            const result = await handler(options)
            callback?.(result)
          } catch (e: any) {
            handleErrors(`Error processing event "${event}":`, e, socket)
          }
        })
      })

      socket.emit("ready")
      logger.info(`User ${data.userId} is ready in sandbox ${data.sandboxId}`)

      socket.on("disconnect", async () => {
        try {
          logger.info(`User ${data.userId} disconnected from sandbox ${data.sandboxId}`)
          connections.removeConnectionForSandbox(socket, data.sandboxId, data.isOwner)
          logger.info(`Deregistered connection for sandbox ${data.sandboxId}`)

          if (data.isOwner && !connections.ownerIsConnected(data.sandboxId)) {
            logger.info(
              `Owner disconnected from sandbox ${data.sandboxId}. Disconnecting sandbox.`
            )
            await sandbox.disconnect()
            delete sandboxes[data.sandboxId]
            socket.broadcast.emit(
              "disableAccess",
              "The sandbox owner has disconnected."
            )
            logger.info(
              `Sandbox ${data.sandboxId} disconnected and removed from active sandboxes`
            )
          }
        } catch (e: any) {
          handleErrors("Error disconnecting:", e, socket)
        }
      })
    } catch (e: any) {
      handleErrors(`Error initializing sandbox ${data.sandboxId}:`, e, socket)
    }
  } catch (e: any) {
    handleErrors("Error connecting:", e, socket)
  }
})

httpServer.listen(port, () => {
  logger.info(`Server running on port ${port}`)
})
