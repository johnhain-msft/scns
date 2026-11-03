import { describe, it, expect } from 'vitest'
import { assembleTraceTree, flattenTraceTree } from '../../../src/otel/trace-assembler.js'
import type { OtelSpan } from '../../../src/otel/otel-repository.js'

describe('trace-assembler', () => {
  function makeOtelSpan(overrides?: Partial<OtelSpan>): OtelSpan {
    return {
      trace_id: 'trace-001',
      span_id: 'span-1',
      parent_span_id: null,
      name: 'test-span',
      kind: 'INTERNAL',
      start_time: '2024-01-15T10:00:00.000Z',
      end_time: '2024-01-15T10:00:01.000Z',
      duration_ms: 1000,
      status: 'OK',
      attributes_json: '{}',
      events_json: '[]',
      resource_json: '{}',
      session_id: null,
      created_at: '2024-01-15T10:00:00',
      ...overrides,
    }
  }

  // ── assembleTraceTree ────────────────────────────────────────

  describe('assembleTraceTree', () => {
    it('builds simple parent-child tree', () => {
      const spans: ReadonlyArray<OtelSpan> = [
        makeOtelSpan({ span_id: 'root', parent_span_id: null, name: 'root-span' }),
        makeOtelSpan({ span_id: 'child', parent_span_id: 'root', name: 'child-span' }),
      ]

      const tree = assembleTraceTree(spans)
      expect(tree).not.toBeNull()
      expect(tree!.span.span_id).toBe('root')
      expect(tree!.children).toHaveLength(1)
      expect(tree!.children[0]!.span.span_id).toBe('child')
      expect(tree!.depth).toBe(0)
      expect(tree!.children[0]!.depth).toBe(1)
    })

    it('builds 3-level deep tree', () => {
      const spans: ReadonlyArray<OtelSpan> = [
        makeOtelSpan({ span_id: 'root', parent_span_id: null, name: 'invoke_agent' }),
        makeOtelSpan({ span_id: 'mid', parent_span_id: 'root', name: 'chat openai/gpt-4' }),
        makeOtelSpan({ span_id: 'leaf', parent_span_id: 'mid', name: 'execute_tool grep' }),
      ]

      const tree = assembleTraceTree(spans)
      expect(tree).not.toBeNull()
      expect(tree!.span.name).toBe('invoke_agent')
      expect(tree!.children).toHaveLength(1)
      expect(tree!.children[0]!.span.name).toBe('chat openai/gpt-4')
      expect(tree!.children[0]!.children).toHaveLength(1)
      expect(tree!.children[0]!.children[0]!.span.name).toBe('execute_tool grep')
      expect(tree!.children[0]!.children[0]!.depth).toBe(2)
    })

    it('handles multiple children at same level', () => {
      const spans: ReadonlyArray<OtelSpan> = [
        makeOtelSpan({ span_id: 'root', parent_span_id: null }),
        makeOtelSpan({ span_id: 'c1', parent_span_id: 'root', name: 'child-1' }),
        makeOtelSpan({ span_id: 'c2', parent_span_id: 'root', name: 'child-2' }),
        makeOtelSpan({ span_id: 'c3', parent_span_id: 'root', name: 'child-3' }),
      ]

      const tree = assembleTraceTree(spans)
      expect(tree!.children).toHaveLength(3)
    })

    it('handles single span (no children)', () => {
      const spans: ReadonlyArray<OtelSpan> = [
        makeOtelSpan({ span_id: 'solo', parent_span_id: null }),
      ]

      const tree = assembleTraceTree(spans)
      expect(tree).not.toBeNull()
      expect(tree!.span.span_id).toBe('solo')
      expect(tree!.children).toHaveLength(0)
    })

    it('uses earliest span as root when no span has null parent_span_id', () => {
      const spans: ReadonlyArray<OtelSpan> = [
        makeOtelSpan({
          span_id: 's2',
          parent_span_id: 'external',
          name: 'later',
          start_time: '2024-01-15T10:00:02.000Z',
        }),
        makeOtelSpan({
          span_id: 's1',
          parent_span_id: 'external',
          name: 'earliest',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
      ]

      const tree = assembleTraceTree(spans)
      expect(tree).not.toBeNull()
      expect(tree!.span.name).toBe('earliest')
    })

    it('returns null for empty array', () => {
      expect(assembleTraceTree([])).toBeNull()
    })
  })

  // ── flattenTraceTree ─────────────────────────────────────────

  describe('flattenTraceTree', () => {
    it('returns DFS order with correct depth values', () => {
      const spans: ReadonlyArray<OtelSpan> = [
        makeOtelSpan({ span_id: 'root', parent_span_id: null, name: 'root' }),
        makeOtelSpan({ span_id: 'c1', parent_span_id: 'root', name: 'child-1' }),
        makeOtelSpan({ span_id: 'c1a', parent_span_id: 'c1', name: 'grandchild' }),
        makeOtelSpan({ span_id: 'c2', parent_span_id: 'root', name: 'child-2' }),
      ]

      const tree = assembleTraceTree(spans)!
      const flat = flattenTraceTree(tree)

      expect(flat).toHaveLength(4)
      expect(flat[0]!.span.name).toBe('root')
      expect(flat[0]!.depth).toBe(0)
      expect(flat[1]!.span.name).toBe('child-1')
      expect(flat[1]!.depth).toBe(1)
      expect(flat[2]!.span.name).toBe('grandchild')
      expect(flat[2]!.depth).toBe(2)
      expect(flat[3]!.span.name).toBe('child-2')
      expect(flat[3]!.depth).toBe(1)
    })
  })
})
