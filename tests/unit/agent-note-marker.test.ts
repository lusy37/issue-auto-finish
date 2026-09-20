import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubClient, AGENT_NOTE_MARKER } from '../../src/clients/GitHubClient.js';

describe('AGENT_NOTE_MARKER', () => {
  it('contains the HTML comment marker', () => {
    expect(AGENT_NOTE_MARKER).toContain('<!-- issue-auto-finish-agent -->');
  });
});

describe('GitHubClient agent note marker', () => {
  let client: GitHubClient;
  let fetchSpy: import('vitest').MockInstance<typeof fetch>;

  beforeEach(() => {
    client = new GitHubClient({
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository: 'test/project',
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('createIssueNote appends marker to body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await client.createIssueNote(100, 'Hello world');

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options?.body as string);
    expect(body.body).toBe('Hello world' + AGENT_NOTE_MARKER);
    expect(body.body).toContain('<!-- issue-auto-finish-agent -->');
  });

  it('createPullRequestNote appends marker to body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await client.createPullRequestNote(5, 'PR comment');

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options?.body as string);
    expect(body.body).toBe('PR comment' + AGENT_NOTE_MARKER);
  });
});

describe('GitHubClient.cleanupAgentNotes', () => {
  let client: GitHubClient;
  let fetchSpy: import('vitest').MockInstance<typeof fetch>;

  beforeEach(() => {
    client = new GitHubClient({
      apiUrl: 'https://github.example.com',
      token: 'test-token',
      repository: 'test/project',
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('deletes notes containing the marker', async () => {
    const notesResponse = [
      { id: 1, body: 'User comment without marker', author: { username: 'u', name: 'U' }, created_at: '' },
      { id: 2, body: 'Agent note\n\n<!-- issue-auto-finish-agent -->', author: { username: 'bot', name: 'Bot' }, created_at: '' },
      { id: 3, body: 'Another agent\n\n<!-- issue-auto-finish-agent -->', author: { username: 'bot', name: 'Bot' }, created_at: '' },
    ];

    // listIssueNotes (page 1 returns 3 notes, page 2 returns 0 would be < 100 so single page)
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(notesResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    // deleteIssueNote for id 2
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    // deleteIssueNote for id 3
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const deleted = await client.cleanupAgentNotes(100);

    expect(deleted).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const deleteUrls = fetchSpy.mock.calls.slice(1).map(c => c[0]);
    expect(deleteUrls[0]).toContain('/comments/2');
    expect(deleteUrls[1]).toContain('/comments/3');

    const deleteOptions = fetchSpy.mock.calls.slice(1).map(c => c[1]);
    expect(deleteOptions[0]?.method).toBe('DELETE');
    expect(deleteOptions[1]?.method).toBe('DELETE');
  });

  it('returns 0 when no agent notes exist', async () => {
    const notesResponse = [
      { id: 1, body: 'User comment', author: { username: 'u', name: 'U' }, created_at: '' },
    ];

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(notesResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const deleted = await client.cleanupAgentNotes(100);

    expect(deleted).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles empty notes list', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const deleted = await client.cleanupAgentNotes(100);
    expect(deleted).toBe(0);
  });

  it('paginates when first page is full (100 notes)', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: 'plain note',
      author: { username: 'u', name: 'U' },
      created_at: '',
    }));
    const secondPage = [
      { id: 101, body: 'agent\n\n<!-- issue-auto-finish-agent -->', author: { username: 'bot', name: 'Bot' }, created_at: '' },
    ];

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(fullPage), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(secondPage), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    // DELETE for note 101
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const deleted = await client.cleanupAgentNotes(100);
    expect(deleted).toBe(1);
    // 2 list pages + 1 delete
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
