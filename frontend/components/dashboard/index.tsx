"use client"

import { Button } from "@/components/ui/button"
import CustomButton from "@/components/ui/customButton"
import { Sandbox } from "@/lib/types"
import { Code2, FolderDot, HelpCircle, Plus, Users } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import AboutModal from "./about"
import NewProjectModal from "./newProject"
import DashboardProjects from "./projects"
import DashboardSharedWithMe from "./shared"

type TScreen = "projects" | "shared" | "settings" | "search"

export default function Dashboard({
  sandboxes,
  shared,
}: {
  sandboxes: Sandbox[]
  shared: {
    id: string
    name: string
    type: "react" | "node"
    author: string
    sharedOn: Date
    authorAvatarUrl?: string
  }[]
}) {
  const [screen, setScreen] = useState<TScreen>("projects")

  const [newProjectModalOpen, setNewProjectModalOpen] = useState(false)
  const [aboutModalOpen, setAboutModalOpen] = useState(false)

  const activeScreen = (s: TScreen) => {
    if (screen === s) return "justify-start"
    else return "justify-start font-normal text-muted-foreground"
  }

  const searchParams = useSearchParams()
  const q = searchParams.get("q")
  const router = useRouter()

  useEffect(() => {
    // update the dashboard to show a new project
    router.refresh()
  }, [])

  return (
    <>
      <NewProjectModal
        open={newProjectModalOpen}
        setOpen={setNewProjectModalOpen}
      />
      <AboutModal open={aboutModalOpen} setOpen={setAboutModalOpen} />
      <div className="flex grow w-full">
        <div className="w-56 shrink-0 border-r border-border p-4 justify-between flex flex-col">
          <div className="flex flex-col">
            <CustomButton
              onClick={() => {
                if (sandboxes.length >= 8) {
                  toast.error("You reached the maximum # of sandboxes.")
                  return
                }
                setNewProjectModalOpen(true)
              }}
              className="mb-4"
            >
              <Plus className="w-4 h-4 mr-2" />
              New Project
            </CustomButton>
            <Button
              variant="ghost"
              onClick={() => setScreen("projects")}
              className={activeScreen("projects")}
            >
              <FolderDot className="w-4 h-4 mr-2" />
              My Projects
            </Button>
            {/* <Button
              variant="ghost"
              onClick={() => setScreen("shared")}
              className={activeScreen("shared")}
            >
              <Users className="w-4 h-4 mr-2" />
              Shared With Me
            </Button> */}
            {/* <Button
              variant="ghost"
              onClick={() => setScreen("settings")}
              className={activeScreen("settings")}
            >
              <Settings className="w-4 h-4 mr-2" />
              Settings
            </Button> */}
          </div>
          <div className="flex flex-col">
            <Button
              onClick={() => setAboutModalOpen(true)}
              variant="ghost"
              className="justify-start font-normal text-muted-foreground"
            >
              <HelpCircle className="w-4 h-4 mr-2" />
              Help
            </Button>
          </div>
        </div>
        {screen === "projects" ? (
          <>
            {sandboxes ? (
              <DashboardProjects sandboxes={sandboxes} q={q} />
            ) : null}
          </>
        ) : screen === "shared" ? (
          <DashboardSharedWithMe
            shared={shared.map((item) => ({
              ...item,
              authorAvatarUrl: item.authorAvatarUrl || "",
            }))}
          />
        ) : screen === "settings" ? null : null}
      </div>
    </>
  )
}
