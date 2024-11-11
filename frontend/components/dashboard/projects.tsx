"use client"

import { deleteSandbox, updateSandbox } from "@/lib/actions"
import { Sandbox } from "@/lib/types"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import ProjectCard from "./projectCard"

const colors: { [key: string]: number[][] } = {
  react: [
    [71, 207, 237],
    [30, 126, 148],
  ],
  node: [
    [86, 184, 72],
    [59, 112, 52],
  ],
}

export default function DashboardProjects({
  sandboxes,
  q,
}: {
  sandboxes: Sandbox[]
  q: string | null
}) {
  const [deletingId, setDeletingId] = useState<string>("")

  const onVisibilityChange = useMemo(
    () => async (sandbox: Pick<Sandbox, "id" | "name" | "visibility">) => {
      const newVisibility =
        sandbox.visibility === "public" ? "private" : "public"
      toast(`Project ${sandbox.name} is now ${newVisibility}.`)
      await updateSandbox({
        id: sandbox.id,
        visibility: newVisibility,
      })
    },
    []
  )

  const onDelete = useMemo(
    () => async (sandbox: Pick<Sandbox, "id" | "name">) => {
      setDeletingId(sandbox.id)
      toast(`Project ${sandbox.name} deleted.`)
      await deleteSandbox(sandbox.id)
    },
    []
  )

  useEffect(() => {
    if (deletingId) {
      setDeletingId("")
    }
  }, [sandboxes])

  return (
    <div className="grow p-4 flex flex-col">
      <div className="text-xl font-medium mb-8">
        {q && q.length > 0 ? `Showing search results for: ${q}` : "My Projects"}
      </div>
      <div className="grow w-full ">
        {sandboxes.length > 0 ? (
          <div className="w-full grid lg:grid-cols-3 2xl:grid-cols-4 md:grid-cols-2 gap-4">
            {sandboxes.map((sandbox) => {
              if (q && q.length > 0) {
                if (!sandbox.name.toLowerCase().includes(q.toLowerCase())) {
                  return null
                }
              }
              return (
                <Link
                  key={sandbox.id}
                  href={`/code/${sandbox.id}`}
                  className={cn(
                    "transition-all focus-visible:outline-none focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-ring rounded-lg",
                    deletingId === sandbox.id
                      ? "pointer-events-none opacity-50 cursor-events-none"
                      : "cursor-pointer"
                  )}
                >
                  <ProjectCard
                    onVisibilityChange={onVisibilityChange}
                    onDelete={onDelete}
                    deletingId={deletingId}
                    isAuthenticated
                    {...sandbox}
                  />
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">
            You don't have any projects yet. Create one to get started!
          </div>
        )}
      </div>
    </div>
  )
}
