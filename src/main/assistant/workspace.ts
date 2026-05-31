// The assistant's workspace: where it scaffolds the projects it decides to
// pursue. This is the assistant's ONE hands-on capability over the filesystem —
// it creates a project folder under ~/.cloxde/workspace and registers it. It
// never edits code inside these folders; that is the team's job (see actions.ts
// for the delegation boundary). Each project gets a fresh directory and the
// default agent profiles so a team can be dispatched into it immediately.

import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { getWorkspaceDir, ensureWorkspaceDir } from '../paths'
import { projectRepo, profileRepo } from '../storage/db'
import type { Project } from '@shared/types'

export interface CreateProjectInput {
  /** Human-readable project name; also the basis for the folder slug. */
  name: string
}

/** Turn a project name into a filesystem-safe slug. Falls back to "project"
 *  when the name has no usable characters (e.g. all punctuation). */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'project'
}

/** Allocate a unique directory under the workspace for `slug`, appending
 *  -2, -3, … if the bare slug is taken. */
function allocateDir(slug: string): string {
  const root = getWorkspaceDir()
  let dir = join(root, slug)
  let n = 2
  while (existsSync(dir)) {
    dir = join(root, `${slug}-${n}`)
    n++
  }
  return dir
}

/** Scaffold a new project in the assistant's workspace: create its folder,
 *  register it, and seed default agent profiles. Returns the persisted
 *  project. The assistant calls this when it decides something is worth doing;
 *  the actual work happens when a team is dispatched into the project. */
export function createProject(input: CreateProjectInput): Project {
  ensureWorkspaceDir()
  const dir = allocateDir(slugify(input.name))
  mkdirSync(dir, { recursive: true })
  const project = projectRepo.upsertByRoot({ name: input.name, rootDir: dir })
  profileRepo.ensureDefaults(project.id)
  return project
}
