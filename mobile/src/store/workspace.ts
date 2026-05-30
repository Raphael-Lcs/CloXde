// Workspace store — the full set of projects and their (active) conversations,
// shared across the tablet workspace (LeftSidebar, the attention badge, and
// the jump-to-conversation modal) so we load once and refresh from a single
// WS subscription rather than each component fetching independently.

import { create } from 'zustand'
import { projects as projectsApi, conversations as convsApi } from '../api/client'
import type { Conversation, Project } from '../types'

interface WorkspaceState {
  projects: Project[]
  convsByProject: Record<string, Conversation[]>
  loading: boolean
  loadAll: () => Promise<void>
  reloadProject: (projectId: string) => Promise<void>
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  projects: [],
  convsByProject: {},
  loading: false,

  loadAll: async () => {
    set({ loading: true })
    const pr = await projectsApi.list()
    if (!pr.ok) {
      set({ loading: false })
      return
    }
    set({ projects: pr.data })
    await Promise.all(pr.data.map((p) => get().reloadProject(p.id)))
    set({ loading: false })
  },

  reloadProject: async (projectId) => {
    const r = await convsApi.listByProject(projectId)
    if (!r.ok) return
    const sorted = [...r.data].sort((a, b) => b.createdAt - a.createdAt)
    set((s) => ({ convsByProject: { ...s.convsByProject, [projectId]: sorted } }))
  }
}))

/** Conversations across all projects currently waiting on the user. */
export interface WaitingConv {
  projectId: string
  projectName: string
  conv: Conversation
}
export function selectWaiting(s: WorkspaceState): WaitingConv[] {
  const out: WaitingConv[] = []
  for (const p of s.projects) {
    for (const c of s.convsByProject[p.id] ?? []) {
      if (c.status === 'awaiting-user' && !c.archivedAt) {
        out.push({ projectId: p.id, projectName: p.name, conv: c })
      }
    }
  }
  return out
}
