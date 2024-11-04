"use client"

import ProjectCard from "@/components/dashboard/projectCard/"
import { CanvasRevealEffect } from "@/components/dashboard/projectCard/revealEffect"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { updateSandbox } from "@/lib/actions"
import { Sandbox, User } from "@/lib/types"
import { PlusCircle } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"
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

export default function ProfilePage({
  publicSandboxes,
  privateSandboxes,
  user,
  currentUser,
}: {
  publicSandboxes: Sandbox[]
  privateSandboxes: Sandbox[]
  user: User
  currentUser: {
    id: string
    firstName: string | null
    lastName: string | null
  } | null
}) {
  const onVisibilityChange = async (sandbox: Sandbox) => {
    const newVisibility = sandbox.visibility === "public" ? "private" : "public"
    toast(`Project ${sandbox.name} is now ${newVisibility}.`)
    await updateSandbox({
      id: sandbox.id,
      visibility: newVisibility,
    })
  }
  const isLoggedIn = Boolean(currentUser)
  const hasPublicSandboxes = publicSandboxes.length > 0
  const hasPrivateSandboxes = privateSandboxes.length > 0
  return (
    <>
      <div className="container mx-auto p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <Card className="mb-6 md:mb-0 sticky top-6">
            <CardContent className="flex flex-col gap-3 items-center pt-6">
              <div className="w-16 h-16 font-mono rounded-full overflow-hidden bg-gradient-to-t from-neutral-800 to-neutral-600 flex items-center justify-center text-sm font-medium">
                <span className="text-2xl text-background">
                  {user.name &&
                    user.name
                      .split(" ")
                      .slice(0, 2)
                      .map((name) => name[0].toUpperCase())}
                </span>
              </div>
              <CardTitle className="text-2xl">{user.name}</CardTitle>
              <CardDescription>@janedoe</CardDescription>
              <p className="text-sm text-muted-foreground">
                Full-stack developer | Open source enthusiast
              </p>
              <p className="text-xs text-muted-foreground">
                Joined January 2023
              </p>
            </CardContent>
          </Card>
        </div>
        <div className="md:col-span-2">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">Sandboxes</h2>
          </div>

          <Tabs defaultValue="public">
            <TabsList className="mb-4">
              <TabsTrigger value="public">Public</TabsTrigger>
              {isLoggedIn && <TabsTrigger value="private">Private</TabsTrigger>}
            </TabsList>
            <TabsContent value="public">
              {hasPublicSandboxes ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {publicSandboxes.map((sandbox) => {
                    return (
                      <Link
                        key={sandbox.id}
                        href={`/code/${sandbox.id}`}
                        className={`cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-ring rounded-lg`}
                      >
                        <ProjectCard
                          sandbox={sandbox}
                          onVisibilityChange={onVisibilityChange}
                          onDelete={() => {}}
                          deletingId={"deletingId"}
                        >
                          <CanvasRevealEffect
                            animationSpeed={3}
                            containerClassName="bg-black"
                            colors={colors[sandbox.type]}
                            dotSize={2}
                          />
                          <div className="absolute inset-0 [mask-image:radial-gradient(400px_at_center,white,transparent)] bg-background/75" />
                        </ProjectCard>
                      </Link>
                    )
                  })}
                </div>
              ) : (
                <EmptyState
                  title="No public sandboxes yet"
                  description="Create your first public sandbox to share your work with the world!"
                />
              )}
            </TabsContent>
            {isLoggedIn && (
              <TabsContent value="private">
                {hasPrivateSandboxes ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {privateSandboxes.map((sandbox) => (
                      <Link
                        key={sandbox.id}
                        href={`/code/${sandbox.id}`}
                        className={`cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-ring rounded-lg`}
                      >
                        <ProjectCard
                          sandbox={sandbox}
                          onVisibilityChange={onVisibilityChange}
                          onDelete={() => {}}
                          deletingId={"deletingId"}
                        >
                          <CanvasRevealEffect
                            animationSpeed={3}
                            containerClassName="bg-black"
                            colors={colors[sandbox.type]}
                            dotSize={2}
                          />
                          <div className="absolute inset-0 [mask-image:radial-gradient(400px_at_center,white,transparent)] bg-background/75" />
                        </ProjectCard>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No private sandboxes yet"
                    description="Create your first private sandbox to start working on your personal projects!"
                  />
                )}
              </TabsContent>
            )}
          </Tabs>
        </div>
      </div>
    </>
  )
}

function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <Card className="flex flex-col items-center justify-center p-6 text-center h-[300px]">
      <PlusCircle className="h-12 w-12 text-muted-foreground mb-4" />
      <CardTitle className="text-xl mb-2">{title}</CardTitle>
      <CardDescription className="mb-4">{description}</CardDescription>
      <Button>
        <PlusCircle className="h-4 w-4 mr-2" />
        Create Sandbox
      </Button>
    </Card>
  )
}
