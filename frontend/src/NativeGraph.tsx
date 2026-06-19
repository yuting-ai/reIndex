import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Network } from 'vis-network';
import { DataSet } from 'vis-data';
import 'vis-network/styles/vis-network.css';

interface GraphNode {
  id: string;
  label: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

interface GraphSchema {
  labels: string[];
  relationships: string[];
}

const BASE_API = 'http://127.0.0.1:8001';

const LABEL_COLORS: Record<string, string> = {
  File: '#6366f1',
  Topic: '#a855f7',
  Entity: '#3b82f6',
  Document: '#22d3ee',
};

const REL_COLORS: Record<string, string> = {
  CONTAINS: '#22c55e',
  RELATES_TO: '#f59e0b',
  WORKS_AT: '#6366f1',
  RESPONSIBLE_FOR: '#ec4899',
  MENTIONS: '#14b8a6',
  INVESTED_IN: '#f97316',
  MANAGES: '#8b5cf6',
  PARTICIPATES_IN: '#06b6d4',
  SERVES_AS: '#a855f7',
  APPROVED: '#10b981',
  FUNDED: '#f59e0b',
  BELONGS_TO: '#64748b',
  PRODUCES: '#84cc16',
  PROVIDES: '#0ea5e9',
  LOCATED_IN: '#ef4444',
};

function getLabelColor(label: string) {
  return LABEL_COLORS[label] || '#64748b';
}

function getRelColor(type: string) {
  return REL_COLORS[type] || '#94a3b8';
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="white">
      <path d="M4.5 9L1.5 6l1-1 2 2 5-5 1 1-6 6z" />
    </svg>
  );
}

export default function NativeGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesRef = useRef<any>(null);
  const edgesRef = useRef<any>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [allNodes, setAllNodes] = useState<GraphNode[]>([]);
  const [allEdges, setAllEdges] = useState<GraphEdge[]>([]);
  const [schema, setSchema] = useState<GraphSchema | null>(null);
  const [showFilters, setShowFilters] = useState(true);

  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [selectedRels, setSelectedRels] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        setError('');

        const [schemaRes, graphRes] = await Promise.all([
          fetch(`${BASE_API}/api/graph/schema`),
          fetch(`${BASE_API}/api/graph/explore?limit=500`),
        ]);

        if (!schemaRes.ok) {
          const body = await schemaRes.json().catch(() => ({}));
          throw new Error(body.detail || `Schema error: ${schemaRes.status}`);
        }
        if (!graphRes.ok) {
          const body = await graphRes.json().catch(() => ({}));
          throw new Error(body.detail || `Graph error: ${graphRes.status}`);
        }

        const schemaData: GraphSchema = await schemaRes.json();
        const graphData = await graphRes.json();

        if (cancelled) return;

        setSchema(schemaData);
        setAllNodes(graphData.nodes ?? []);
        setAllEdges(graphData.edges ?? []);
        setSelectedLabels(new Set(schemaData.labels));
        setSelectedRels(new Set(schemaData.relationships));
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          console.error('Graph load error:', err);
          setError(err.message || String(err));
          setLoading(false);
        }
      }
    };

    load();
    return () => { cancelled = true; };
  }, []);

  const filteredNodes = useMemo(() => {
    let nodes = allNodes;
    nodes = nodes.filter((n) => n.labels.some((l) => selectedLabels.has(l)));
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      nodes = nodes.filter((n) => n.label.toLowerCase().includes(q));
    }
    return nodes;
  }, [allNodes, selectedLabels, searchQuery]);

  const visibleNodeIds = useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes]
  );

  const filteredEdges = useMemo(() => {
    let edges = allEdges;
    edges = edges.filter((e) => selectedRels.has(e.label));
    edges = edges.filter(
      (e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)
    );
    return edges;
  }, [allEdges, selectedRels, visibleNodeIds]);

  const toggleLabel = useCallback((label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const toggleRel = useCallback((rel: string) => {
    setSelectedRels((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  const setAllLabels = useCallback((v: boolean) => {
    setSelectedLabels(new Set(v && schema ? schema.labels : []));
  }, [schema]);

  const setAllRels = useCallback((v: boolean) => {
    setSelectedRels(new Set(v && schema ? schema.relationships : []));
  }, [schema]);

  useEffect(() => {
    if (!containerRef.current || filteredNodes.length === 0) return;

    if (nodesRef.current && edgesRef.current && networkRef.current) {
      nodesRef.current.clear();
      edgesRef.current.clear();
    }

    const nodes = new DataSet(
      filteredNodes.map((n) => {
        const primary = n.labels?.[0] || 'Entity';
        return {
          id: n.id,
          label: n.label,
          group: primary,
          color: {
            background: getLabelColor(primary),
            border: 'rgba(0,0,0,0.15)',
            highlight: { background: '#fff', border: getLabelColor(primary) },
          },
          font: { color: '#1e293b', size: 12 },
          borderWidth: 1,
          size:
            primary === 'File' || primary === 'Document'
              ? 25
              : primary === 'Topic'
                ? 18
                : 12,
          title: `Type: ${primary}<br/>Name: ${n.label}`,
        };
      })
    );

    const edges = new DataSet(
      filteredEdges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        label: e.label,
        color: {
          color: getRelColor(e.label),
          highlight: '#60a5fa',
          opacity: 0.6,
        },
        font: { color: '#94a3b8', size: 10, strokeWidth: 0 },
        width: 1,
        smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
        title: `${e.label}`,
      }))
    );

    nodesRef.current = nodes;
    edgesRef.current = edges;

    if (networkRef.current) {
      networkRef.current.destroy();
    }

    const options = {
      nodes: {
        shape: 'dot',
        scaling: { min: 8, max: 30 },
        font: { face: 'system-ui, -apple-system, sans-serif' },
      },
      edges: {
        arrows: { to: { enabled: true, scaleFactor: 0.6 } },
        font: { align: 'middle' },
        smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
      },
      physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -40,
          centralGravity: 0.005,
          springLength: 180,
          springConstant: 0.02,
          damping: 0.4,
        },
        stabilization: { iterations: 100 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        zoomView: true,
        dragView: true,
        dragNodes: true,
        hideEdgesOnDrag: true,
      },
      layout: { improvedLayout: true },
    };

    networkRef.current = new Network(containerRef.current!, { nodes, edges }, options);

    networkRef.current.once('stabilizationIterationsDone', () => {
      if (networkRef.current) {
        networkRef.current.setOptions({ physics: false });
      }
    });
  }, [filteredNodes, filteredEdges]);

  const isEmpty =
    !loading && !error && allNodes.length === 0;
  const noMatch =
    !loading && !error && allNodes.length > 0 && filteredNodes.length === 0;

  return (
    <div style={{ flex: 1, position: 'relative', background: '#f5f5f7', overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Header */}
      <div
        style={{
          position: 'absolute',
          top: 24,
          left: 24,
          pointerEvents: 'none',
          zIndex: 10,
        }}
      >
        <div
          style={{
            color: 'var(--text-tertiary)',
            fontSize: '11px',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          {loading
            ? 'Loading...'
            : `${filteredNodes.length} nodes · ${filteredEdges.length} edges`}
        </div>
      </div>

      {/* Filter toggle */}
      <button
        onClick={() => setShowFilters((v) => !v)}
        style={{
          position: 'absolute',
          top: 24,
          right: 24,
          zIndex: 20,
          background: 'rgba(255,255,255,0.8)',
          border: '1px solid rgba(0,0,0,0.1)',
          borderRadius: '6px',
          color: '#64748b',
          padding: '6px 12px',
          fontSize: '12px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
        </svg>
        {showFilters ? 'Hide Filters' : 'Filters'}
      </button>

      {/* Filter panel */}
      {showFilters && (
        <div
          style={{
            position: 'absolute',
            top: 72,
            right: 24,
            bottom: 24,
            width: 240,
            zIndex: 20,
            background: 'rgba(255,255,255,0.95)',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: '10px',
            padding: '14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            backdropFilter: 'blur(12px)',
            overflow: 'hidden',
          }}
        >
          {/* Search */}
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            style={{
              background: 'rgba(0,0,0,0.04)',
              border: '1px solid rgba(0,0,0,0.1)',
              borderRadius: '6px',
              padding: '8px 10px',
              color: '#1e293b',
              fontSize: '12px',
              outline: 'none',
              width: '100%',
              boxSizing: 'border-box',
            }}
          />

          {/* Node Labels */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '45%' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 4,
                flexShrink: 0,
              }}
            >
              <span style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Node Types
              </span>
              <span style={{ color: '#94a3b8', fontSize: 10, cursor: 'pointer', userSelect: 'none' }}
                onClick={() => setAllLabels(selectedLabels.size !== (schema?.labels.length ?? 0))}
              >
                {selectedLabels.size === (schema?.labels.length ?? 0) ? 'Deselect All' : 'Select All'}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {(schema?.labels ?? []).map((label) => {
                const checked = selectedLabels.has(label);
                return (
                  <label
                    key={label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 6px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 12,
                      color: checked ? '#1e293b' : '#94a3b8',
                    }}
                    onMouseOver={(e) =>
                      (e.currentTarget.style.background = 'rgba(0,0,0,0.04)')
                    }
                    onMouseOut={(e) =>
                      (e.currentTarget.style.background = 'transparent')
                    }
                  >
                    <div
                      className={`custom-checkbox ${checked ? 'checked' : ''}`}
                      onClick={(e) => {
                        e.preventDefault();
                        toggleLabel(label);
                      }}
                      style={{ width: 14, height: 14, flexShrink: 0 }}
                    >
                      {checked && <CheckIcon />}
                    </div>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: getLabelColor(label),
                        flexShrink: 0,
                      }}
                    />
                    {label}
                    <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 10 }}>
                      {allNodes.filter((n) => n.labels.includes(label)).length}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div style={{ height: 1, background: 'rgba(0,0,0,0.06)', flexShrink: 0 }} />

          {/* Relationship Types */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 4,
                flexShrink: 0,
              }}
            >
              <span style={{ color: '#64748b', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Relationships
              </span>
              <span style={{ color: '#94a3b8', fontSize: 10, cursor: 'pointer', userSelect: 'none' }}
                onClick={() => setAllRels(selectedRels.size !== (schema?.relationships.length ?? 0))}
              >
                {selectedRels.size === (schema?.relationships.length ?? 0) ? 'Deselect All' : 'Select All'}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {(schema?.relationships ?? []).map((rel) => {
                const checked = selectedRels.has(rel);
                return (
                  <label
                    key={rel}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '4px 6px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      fontSize: 12,
                      color: checked ? '#1e293b' : '#94a3b8',
                    }}
                    onMouseOver={(e) =>
                      (e.currentTarget.style.background = 'rgba(0,0,0,0.04)')
                    }
                    onMouseOut={(e) =>
                      (e.currentTarget.style.background = 'transparent')
                    }
                  >
                    <div
                      className={`custom-checkbox ${checked ? 'checked' : ''}`}
                      onClick={(e) => {
                        e.preventDefault();
                        toggleRel(rel);
                      }}
                      style={{ width: 14, height: 14, flexShrink: 0 }}
                    >
                      {checked && <CheckIcon />}
                    </div>
                    <svg width="14" height="4" viewBox="0 0 14 4" style={{ flexShrink: 0 }}>
                      <line x1="0" y1="2" x2="10" y2="2" stroke={getRelColor(rel)} strokeWidth="2" />
                      <polygon points="10,0 14,2 10,4" fill={getRelColor(rel)} />
                    </svg>
                    {rel}
                    <span style={{ marginLeft: 'auto', color: '#94a3b8', fontSize: 10 }}>
                      {allEdges.filter((e) => e.label === rel).length}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--text-secondary)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="icon" style={{ animation: 'spin 1s linear infinite' }}>
              ↻
            </span>
            Loading graph from Neo4j...
          </div>
        </div>
      )}

      {/* Empty / No match */}
      {isEmpty && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--text-secondary)',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          Knowledge graph is empty.
          <br />
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
            Scan files to populate the graph.
          </span>
        </div>
      )}
      {noMatch && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--text-secondary)',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          No nodes match current filters.
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            position: 'absolute',
            bottom: 30,
            left: 30,
            background: 'rgba(255,10,10,0.1)',
            border: '1px solid rgba(255,10,10,0.3)',
            color: '#ff4444',
            padding: '12px 16px',
            borderRadius: 8,
            fontSize: 12,
            maxWidth: 450,
          }}
        >
          <strong>Graph Error:</strong>
          <br />
          {error}
          <span
            style={{
              color: 'var(--text-tertiary)',
              marginTop: 8,
              display: 'block',
            }}
          >
            Ensure your local Neo4j database is running and the backend server is
            started.
          </span>
        </div>
      )}
    </div>
  );
}
