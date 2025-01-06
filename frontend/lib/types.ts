// DB Types

import { KNOWN_PLATFORMS } from "./constants"

export type User = {
  id: string
  name: string
  email: string
  username: string
  avatarUrl: string | null
  createdAt: Date
  generations: number
  bio: string | null
  personalWebsite: string | null
  links: UserLink[]
  tier: "FREE" | "PRO" | "ENTERPRISE"
  tierExpiresAt: Date
  lastResetDate: number
  sandbox: Sandbox[]
  usersToSandboxes: UsersToSandboxes[]
}

export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number]
export type UserLink = {
  url: string
  platform: KnownPlatform
}

export type Sandbox = {
  id: string
  name: string
  type: string
  visibility: "public" | "private"
  createdAt: Date
  userId: string
  likeCount: number
  viewCount: number
  usersToSandboxes: UsersToSandboxes[]
}
export type SandboxWithLiked = Sandbox & {
  liked: boolean
}
export type UsersToSandboxes = {
  userId: string
  sandboxId: string
  sharedOn: Date
}

export type R2Files = {
  objects: R2FileData[]
  truncated: boolean
  delimitedPrefixes: any[]
}

export type R2FileData = {
  storageClass: string
  uploaded: string
  checksums: any
  httpEtag: string
  etag: string
  size: number
  version: string
  key: string
}

export type TFolder = {
  id: string
  type: "folder"
  name: string
  children: (TFile | TFolder)[]
}

export type TFile = {
  id: string
  type: "file"
  name: string
}

export type TTab = TFile & {
  saved: boolean
}

export type TFileData = {
  id: string
  data: string
}
