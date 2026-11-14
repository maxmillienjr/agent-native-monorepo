import { describe, expect, it } from 'vitest';
import { IO_RETRY } from '../graph/retry.js';
import { EmptyReplyError, invokeChat, replyText, type ChatReply } from './gemini-chat.js';

const request = { model: 'gemini-3.5-flash-lite', seam: 'plan.callLlm', json: false } as const;

function client(reply: ChatReply) {
  return { invoke: async () => reply };
}

describe('replyText', () => {
  it('passes a string through', () => {
    expect(replyText('a plan')).toBe('a plan');
  });

  it('joins the text parts of a multi-part reply, which used to read as empty', () => {
    // The shape `@langchain/google-genai` builds from a candidate with two parts.
    const content = [
      { type: 'text', text: '1. Search for ' },
      { type: 'text', text: 'the user’s preference.' },
    ];
    expect(replyText(content)).toBe('1. Search for the user’s preference.');
  });

  it('leaves thinking parts out of the answer', () => {
    const content = [
      { type: 'thinking', thinking: 'The user asks…', signature: 'sig' },
      { type: 'text', text: 'the answer' },
    ];
    expect(replyText(content)).toBe('the answer');
  });

  it('reads anything else as no text', () => {
    expect(replyText([])).toBe('');
    expect(replyText(undefined)).toBe('');
    expect(replyText([{ type: 'functionCall', functionCall: {} }])).toBe('');
  });
});

describe('invokeChat', () => {
  it('returns the joined text of a multi-part reply', async () => {
    const reply = {
      content: [
        { type: 'text', text: 'a ' },
        { type: 'text', text: 'plan' },
      ],
    };
    const result = await invokeChat(client(reply), request, 's', 'u');
    expect(result.content).toBe('a plan');
  });

  it('throws EmptyReplyError, naming the finish reason, on a reply with no text', async () => {
    const reply = { content: [], response_metadata: { finishReason: 'STOP' } };
    const call = invokeChat(client(reply), request, 's', 'u');
    await expect(call).rejects.toBeInstanceOf(EmptyReplyError);
    await expect(call).rejects.toThrow(
      'plan.callLlm: the model replied with no text (finish reason STOP)',
    );
  });

  it('throws on whitespace alone', async () => {
    await expect(invokeChat(client({ content: '  \n' }), request, 's', 'u')).rejects.toBeInstanceOf(
      EmptyReplyError,
    );
  });

  it('is an error IO_RETRY retries, so the node makes the call again', () => {
    expect(IO_RETRY.retryOn?.(new EmptyReplyError('plan.callLlm', ['STOP']))).toBe(true);
  });
});
