import { useState, useCallback } from 'react';
import type { StreamEvent } from '@repo/agent-contracts';
import { RunForm } from './components/RunForm.js';
import { StreamViewer } from './components/StreamViewer.js';
import { RunInspector } from './components/RunInspector.js';

interface RunMetadata {
  runId?: string;
  sessionId?: string;
  outcome?: string;
  tokenCounts?: { prompt: number; completion: number };
}

export function App() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [metadata, setMetadata] = useState<RunMetadata | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const handleSubmit = useCallback(async (sessionId: string, query: string) => {
    setEvents([]);
    setMetadata(null);
    setIsStreaming(true);

    try {
      const response = await fetch('/api/runs/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messages: [{ role: 'user', content: query }],
        }),
      });

      if (!response.ok || !response.body) {
        setIsStreaming(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as StreamEvent;
              setEvents((prev) => [...prev, event]);

              // Only the terminal frame, `done` or `error`, carries `state`.
              if (event.state?.runId) {
                setMetadata((prev) => ({
                  ...prev,
                  runId: event.state?.runId ?? prev?.runId,
                  sessionId: event.state?.sessionId ?? prev?.sessionId,
                  outcome: event.state?.outcome ?? prev?.outcome,
                  tokenCounts: event.state?.tokenCounts ?? prev?.tokenCounts,
                }));
              }
            } catch {
              // Skip malformed events
            }
          }
        }
      }
    } finally {
      setIsStreaming(false);
    }
  }, []);

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '2rem 1rem' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600, color: '#a0a0ff' }}>Agent Console</h1>
        <p style={{ fontSize: '0.875rem', color: '#808090' }}>
          LangGraph state machine with Three-Brain memory architecture
        </p>
      </header>

      <RunForm onSubmit={handleSubmit} isDisabled={isStreaming} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1rem',
          marginTop: '1.5rem',
        }}
      >
        <StreamViewer events={events} isStreaming={isStreaming} />
        <RunInspector metadata={metadata} />
      </div>
    </div>
  );
}
