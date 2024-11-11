"use client"

import ProjectCard from "@/components/dashboard/projectCard/"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { deleteSandbox, updateSandbox } from "@/lib/actions"
import { MAX_FREE_GENERATION } from "@/lib/constant"
import { Sandbox, User } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Heart, LucideIcon, Package2, PlusCircle, Sparkles } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import Avatar from "../ui/avatar"
import { Badge } from "../ui/badge"
import { Progress } from "../ui/progress"

export default function ProfilePage({
  publicSandboxes,
  privateSandboxes,
  user,
  currentUser,
}: {
  publicSandboxes: Sandbox[]
  privateSandboxes: Sandbox[]
  user: User
  currentUser: User | null
}) {
  const [deletingId, setDeletingId] = useState<string>("")
  const isLoggedIn = Boolean(currentUser)
  const hasPublicSandboxes = publicSandboxes.length > 0
  const hasPrivateSandboxes = privateSandboxes.length > 0

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
      setDeletingId("")
    },
    []
  )
  const stats = useMemo(() => {
    const allSandboxes = isLoggedIn
      ? [...publicSandboxes, ...privateSandboxes]
      : publicSandboxes

    const totalSandboxes = allSandboxes.length
    const totalLikes = allSandboxes.reduce(
      (sum, sandbox) => sum + sandbox.likeCount,
      0
    )

    return {
      sandboxes:
        totalSandboxes === 1 ? "1 sandbox" : `${totalSandboxes} sandboxes`,
      likes: totalLikes === 1 ? "1 like" : `${totalLikes} likes`,
    }
  }, [isLoggedIn, publicSandboxes, privateSandboxes])
  const joinDate = useMemo(
    () =>
      new Date(user.createdAt).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }),
    [user.createdAt]
  )

  return (
    <>
      <div className="container mx-auto p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <Card className="mb-6 md:mb-0 sticky top-6">
            <CardContent className="flex flex-col gap-3 items-center pt-6">
              <Avatar
                name={user.name}
                avatarUrl={user.avatarUrl}
                className="size-36"
              />

              <CardTitle className="text-2xl">{user.name}</CardTitle>
              <CardDescription>{`@${user.username}`}</CardDescription>
              <div className="flex gap-6">
                <StatsItem icon={Package2} label={stats.sandboxes} />
                <StatsItem icon={Heart} label={stats.likes} />
              </div>
              <div className="flex flex-col items-center gap-2">
                <p className="text-xs text-muted-foreground">
                  {`Joined ${joinDate}`}
                </p>
                {isLoggedIn && <SubscriptionBadge user={currentUser!} />}
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="md:col-span-2">
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
                        className={cn(
                          "transition-all focus-visible:outline-none focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-ring rounded-lg",
                          deletingId === sandbox.id
                            ? "pointer-events-none opacity-50 cursor-events-none"
                            : "cursor-pointer"
                        )}
                      >
                        {isLoggedIn ? (
                          <ProjectCard
                            onVisibilityChange={onVisibilityChange}
                            onDelete={onDelete}
                            deletingId={deletingId}
                            isAuthenticated
                            {...sandbox}
                          />
                        ) : (
                          <ProjectCard isAuthenticated={false} {...sandbox} />
                        )}
                      </Link>
                    )
                  })}
                </div>
              ) : (
                <EmptyState
                  title="No public sandboxes yet"
                  description={
                    isLoggedIn
                      ? "Create your first public sandbox to share your work with the world!"
                      : "Login to create public sandboxes"
                  }
                  isLoggedIn={isLoggedIn}
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
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="No private sandboxes yet"
                    description={
                      isLoggedIn
                        ? "Create your first private sandbox to start working on your personal projects!"
                        : "Login to create private sandboxes"
                    }
                    isLoggedIn={isLoggedIn}
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
  isLoggedIn,
}: {
  title: string
  description: string
  isLoggedIn: boolean
}) {
  return (
    <Card className="flex flex-col items-center justify-center p-6 text-center h-[300px]">
      <PlusCircle className="h-12 w-12 text-muted-foreground mb-4" />
      <CardTitle className="text-xl mb-2">{title}</CardTitle>
      <CardDescription className="mb-4">{description}</CardDescription>
      {isLoggedIn && (
        <Button>
          <PlusCircle className="h-4 w-4 mr-2" />
          Create Sandbox
        </Button>
      )}
    </Card>
  )
}

interface StatsItemProps {
  icon: LucideIcon
  label: string
}

const StatsItem = ({ icon: Icon, label }: StatsItemProps) => (
  <div className="flex items-center gap-2">
    <Icon size={18} />
    <span className="text-sm  text-muted-foreground">{label}</span>
  </div>
)

const SubscriptionBadge = ({ user }: { user: User }) => {
  return (
    <HoverCard>
      <HoverCardTrigger>
        <Badge variant="secondary" className="text-xs cursor-pointer">
          Free
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="w-full space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">AI Generations</span>
            <span>{`${user.generations} / ${MAX_FREE_GENERATION}`}</span>
          </div>
          <Progress
            value={user?.generations!}
            max={MAX_FREE_GENERATION}
            className="w-full"
          />
        </div>
        <Button size="sm" className="w-full mt-4">
          <Sparkles className="mr-2 h-4 w-4" /> Upgrade to Pro
        </Button>
      </HoverCardContent>
    </HoverCard>
  )
}
