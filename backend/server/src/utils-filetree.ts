// /backend/server/src/utils-filetree.ts
import { TFile, TFolder } from "./types"

/**
 * Given an array of file paths like:
 *   ["/index.js", "/src/App.js", "/src/components/Thing.tsx"]
 *
 * This function returns a tree-like structure of nested folders and files:
 * [
 *   {
 *     id: "/src",
 *     type: "folder",
 *     name: "src",
 *     children: [
 *       {
 *         id: "/src/App.js",
 *         type: "file",
 *         name: "App.js"
 *       },
 *       {
 *         id: "/src/components",
 *         type: "folder",
 *         name: "components",
 *         children: [
 *           {
 *             id: "/src/components/Thing.tsx",
 *             type: "file",
 *             name: "Thing.tsx"
 *           }
 *         ]
 *       }
 *     ]
 *   },
 *   {
 *     id: "/index.js",
 *     type: "file",
 *     name: "index.js"
 *   }
 * ]
 *
 */
export function generateFileStructure(paths: string[]): (TFolder | TFile)[] {
  const root: TFolder = {
    id: "/", 
    type: "folder", 
    name: "/", 
    children: [],
  }

  for (const pathString of paths) {
    // Sanitize and split on '/'
    const parts = pathString.split("/").filter(Boolean)
    let current: TFolder = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isFile = i === parts.length - 1 // last part is presumably file

      // See if this folder/file already exists
      let existing = current.children.find(child => child.name === part)

      if (existing) {
        // If it's a folder, descend into it
        if (existing.type === "folder" && !isFile) {
          current = existing
        }
      } else {
        if (isFile) {
          // Create a TFile
          const file: TFile = {
            id: "/" + parts.slice(0, i + 1).join("/"),
            type: "file",
            name: part,
          }
          current.children.push(file)
        } else {
          // Create a TFolder
          const folder: TFolder = {
            id: "/" + parts.slice(0, i + 1).join("/"),
            type: "folder",
            name: part,
            children: [],
          }
          current.children.push(folder)
          current = folder
        }
      }
    }
  }

  return root.children
}
