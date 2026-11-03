import type { OtelSpan } from './otel-repository.js'

export interface SpanNode {
  readonly span: OtelSpan
  readonly children: ReadonlyArray<SpanNode>
  readonly depth: number
}

export function assembleTraceTree(spans: ReadonlyArray<OtelSpan>): SpanNode | null {
  if (spans.length === 0) return null

  // Find root: span with null parent_span_id, or earliest span
  let rootSpan = spans.find((s) => s.parent_span_id === null) ?? null
  if (!rootSpan) {
    rootSpan = [...spans].sort((a, b) => a.start_time.localeCompare(b.start_time))[0]!
  }

  // Build children map: parent_span_id → children spans
  const childrenMap = new Map<string, OtelSpan[]>()
  for (const span of spans) {
    if (span.span_id === rootSpan.span_id) continue
    const parentId = span.parent_span_id ?? rootSpan.span_id
    const list = childrenMap.get(parentId) ?? []
    list.push(span)
    childrenMap.set(parentId, list)
  }

  function buildNode(span: OtelSpan, depth: number): SpanNode {
    const children = (childrenMap.get(span.span_id) ?? []).map((child) =>
      buildNode(child, depth + 1),
    )
    return { span, children, depth }
  }

  return buildNode(rootSpan, 0)
}

export function flattenTraceTree(root: SpanNode): ReadonlyArray<SpanNode> {
  const result: SpanNode[] = []

  function dfs(node: SpanNode): void {
    result.push(node)
    for (const child of node.children) {
      dfs(child)
    }
  }

  dfs(root)
  return result
}
