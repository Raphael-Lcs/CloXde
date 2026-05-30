// Lightweight assertion harness for the ACP update reducer.
//
// applyUpdate folds one ACP session/update into a message's block list. It's
// load-bearing for "continuity": a dropped or mis-folded update means a tool
// call shows wrong status, loses its output, or never appears at all. These
// cases pin the behavior that's easy to regress:
//   • text / thought chunks coalesce into the trailing block
//   • tool_call output comes from ACP `content` (standard), not just rawOutput
//   • file diffs + terminal refs in `content` surface as readable output
//   • tool_call_update upserts (creates) when the id is unknown, never drops
//   • plan blocks replace in place
//
// Run with:  npx tsx scripts/test-update-reducer.ts
// Exit code = number of failures.

import { applyUpdate } from '../src/main/conversation/update-reducer'
import type { MessageBlock } from '../src/shared/types'
import type { SessionNotification } from '@agentclientprotocol/sdk'

type Update = SessionNotification['update']

let passed = 0
let failed = 0
const failures: string[] = []

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  failures.push(label)
  console.log(`  ✕ ${label}`)
}

function eq<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`
  )
}

function section(name: string): void {
  console.log(`\n— ${name} —`)
}

/** Helper: fresh reducer state. */
function fresh(): { blocks: MessageBlock[]; index: Map<string, number> } {
  return { blocks: [], index: new Map() }
}

function toolBlock(blocks: MessageBlock[], id: string): Extract<MessageBlock, { type: 'tool_call' }> | undefined {
  return blocks.find(
    (b): b is Extract<MessageBlock, { type: 'tool_call' }> =>
      b.type === 'tool_call' && b.toolCallId === id
  )
}

// =============================================================================
//                       text / thought chunk coalescing
// =============================================================================

section('agent_message_chunk — consecutive text chunks coalesce')
{
  const s = fresh()
  applyUpdate(s.blocks, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } as Update, s.index)
  applyUpdate(s.blocks, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } as Update, s.index)
  eq(s.blocks.length, 1, 'two text chunks → one block')
  eq((s.blocks[0] as { text: string }).text, 'Hello world', 'text concatenated')
}

section('agent_thought_chunk — thought does not merge into text')
{
  const s = fresh()
  applyUpdate(s.blocks, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'visible' } } as Update, s.index)
  applyUpdate(s.blocks, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } as Update, s.index)
  eq(s.blocks.length, 2, 'text then thought → two blocks')
  eq(s.blocks[0].type, 'text', 'first is text')
  eq(s.blocks[1].type, 'thought', 'second is thought')
}

// =============================================================================
//                       tool_call output from `content`
// =============================================================================

section('tool_call_update — text output comes from ACP content (the bug fix)')
{
  const s = fresh()
  applyUpdate(s.blocks, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' } as Update, s.index)
  applyUpdate(
    s.blocks,
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file contents here' } }]
    } as Update,
    s.index
  )
  const b = toolBlock(s.blocks, 't1')
  eq(b?.status, 'completed', 'status updated to completed')
  eq(b?.output, 'file contents here', 'output extracted from content array')
}

section('tool_call_update — diff content surfaces path + new text')
{
  const s = fresh()
  applyUpdate(s.blocks, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit', kind: 'edit', status: 'in_progress' } as Update, s.index)
  applyUpdate(
    s.blocks,
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'completed',
      content: [{ type: 'diff', path: 'src/a.ts', newText: 'const x = 1' }]
    } as Update,
    s.index
  )
  const b = toolBlock(s.blocks, 't2')
  assert((b?.output ?? '').includes('src/a.ts'), 'diff output mentions path')
  assert((b?.output ?? '').includes('const x = 1'), 'diff output includes new text')
}

section('tool_call_update — rawOutput used only when content absent')
{
  const s = fresh()
  applyUpdate(s.blocks, { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Run', kind: 'execute', status: 'pending' } as Update, s.index)
  applyUpdate(s.blocks, { sessionUpdate: 'tool_call_update', toolCallId: 't3', rawOutput: 'exit 0' } as Update, s.index)
  eq(toolBlock(s.blocks, 't3')?.output, 'exit 0', 'falls back to rawOutput string')
}

section('tool_call_update — content wins over rawOutput')
{
  const s = fresh()
  applyUpdate(s.blocks, { sessionUpdate: 'tool_call', toolCallId: 't4', title: 'X', kind: 'other', status: 'pending' } as Update, s.index)
  applyUpdate(
    s.blocks,
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't4',
      content: [{ type: 'content', content: { type: 'text', text: 'standard' } }],
      rawOutput: 'raw'
    } as Update,
    s.index
  )
  eq(toolBlock(s.blocks, 't4')?.output, 'standard', 'content preferred over rawOutput')
}

// =============================================================================
//                  tool_call_update upsert (never silently drop)
// =============================================================================

section('tool_call_update — unknown id is created (upsert), not dropped')
{
  const s = fresh()
  const changed = applyUpdate(
    s.blocks,
    { sessionUpdate: 'tool_call_update', toolCallId: 'orphan', title: 'Search', kind: 'search', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hits' } }] } as Update,
    s.index
  )
  assert(changed, 'orphan update reports a change (was a silent drop before)')
  const b = toolBlock(s.blocks, 'orphan')
  assert(!!b, 'orphan tool call block was created')
  eq(b?.title, 'Search', 'created block carries title from update')
  eq(b?.status, 'completed', 'created block carries status')
  eq(b?.output, 'hits', 'created block carries content output')
}

// =============================================================================
//                              plan replacement
// =============================================================================

section('plan — replaces in place rather than appending')
{
  const s = fresh()
  applyUpdate(s.blocks, { sessionUpdate: 'plan', entries: [{ priority: 'high', status: 'pending', content: 'step 1' }] } as Update, s.index)
  applyUpdate(s.blocks, { sessionUpdate: 'plan', entries: [{ priority: 'high', status: 'completed', content: 'step 1' }] } as Update, s.index)
  const plans = s.blocks.filter((b) => b.type === 'plan')
  eq(plans.length, 1, 'still a single plan block')
  eq((plans[0] as { entries: { status: string }[] }).entries[0].status, 'completed', 'plan updated in place')
}

// =============================================================================
//                                 SUMMARY
// =============================================================================

console.log('\n' + '='.repeat(60))
console.log(`通过: ${passed}    失败: ${failed}`)
if (failed > 0) {
  console.log('\n失败明细:')
  for (const f of failures) console.log('  • ' + f)
}
console.log('='.repeat(60))
process.exit(failed > 0 ? 1 : 0)
