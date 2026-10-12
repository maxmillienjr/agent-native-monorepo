interface RunMetadata {
  runId?: string;
  sessionId?: string;
  outcome?: string;
  tokenCounts?: { prompt: number; completion: number };
}

interface RunInspectorProps {
  metadata: RunMetadata | null;
}

function MetadataRow({ label, value }: { label: string; value: string | number | undefined }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '0.375rem 0',
        borderBottom: '1px solid #1a1a24',
      }}
    >
      <span style={{ color: '#808090', fontSize: '0.75rem' }}>{label}</span>
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: '0.8125rem',
          color: value ? '#e0e0e8' : '#505060',
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

export function RunInspector({ metadata }: RunInspectorProps) {
  return (
    <section
      aria-label="Run Inspector"
      style={{
        background: '#12121a',
        border: '1px solid #2a2a3a',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '0.5rem 0.75rem',
          borderBottom: '1px solid #2a2a3a',
          fontSize: '0.75rem',
          fontWeight: 600,
          color: '#a0a0ff',
        }}
      >
        Run Inspector
      </div>

      <div style={{ padding: '0.75rem' }}>
        {!metadata ? (
          <span style={{ color: '#505060', fontSize: '0.8125rem' }}>No run data yet</span>
        ) : (
          <>
            <MetadataRow label="Run ID" value={metadata.runId} />
            <MetadataRow label="Session ID" value={metadata.sessionId} />
            <MetadataRow label="Outcome" value={metadata.outcome} />
            <MetadataRow label="Prompt tokens" value={metadata.tokenCounts?.prompt} />
            <MetadataRow label="Completion tokens" value={metadata.tokenCounts?.completion} />
          </>
        )}
      </div>
    </section>
  );
}
