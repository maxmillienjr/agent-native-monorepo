import { useEffect, useRef } from 'react';
import type { StreamEvent } from '@repo/agent-contracts';

interface StreamViewerProps {
  events: StreamEvent[];
  isStreaming: boolean;
}

const nodeColors: Record<string, string> = {
  ingress: '#4caf50',
  retrieve: '#2196f3',
  plan: '#ff9800',
  act: '#9c27b0',
  approve: '#ffc107',
  compensate: '#795548',
  distill: '#f06292',
  reflect: '#e91e63',
  egress: '#00bcd4',
  done: '#808090',
  error: '#ff5252',
};

export function StreamViewer({ events, isStreaming }: StreamViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <div
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
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Stream</span>
        {isStreaming && <span style={{ color: '#4caf50', fontWeight: 400 }}>streaming...</span>}
      </div>

      <div
        ref={scrollRef}
        style={{
          padding: '0.75rem',
          maxHeight: 400,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: '0.8125rem',
        }}
      >
        {events.length === 0 ? (
          <span style={{ color: '#505060' }}>Waiting for events...</span>
        ) : (
          events.map((event, i) => (
            <div key={i} style={{ marginBottom: '0.375rem' }}>
              <span style={{ color: nodeColors[event.node] ?? '#808090' }}>[{event.node}]</span>
              {event.delta && (
                <span style={{ color: '#e0e0e8', marginLeft: '0.5rem' }}>{event.delta}</span>
              )}
              {event.error && (
                <span style={{ color: '#ff5252', marginLeft: '0.5rem' }}>
                  {event.error.node}: {event.error.message}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
