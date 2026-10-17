import type { ToolSpec } from '../explanations/tools.js';
import type { ConversationService } from './service.js';
import { HARNESS_IDS } from '../harnesses/registry.js';

const string = (description: string) => ({ type: 'string', description });
export function conversationTools(conversations: ConversationService): ToolSpec[] {
  return [
    {
      name: 'search_conversations', title: 'Search agent sessions', readOnly: true,
      description: 'Find imported agent sessions for this repository by text or a file/folder observed in tool calls. Reads the local archive; never starts, resumes or imports a session.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { query: string('Search words'), path: string('Filter by an observed file or folder'), provider: { type: 'string', enum: HARNESS_IDS }, action: { type: 'string', enum: ['read', 'edited', 'added'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } } },
      async run(input) { return JSON.stringify(conversations.store.list(input)); },
    },
    {
      name: 'read_conversation', title: 'Read a source agent session', readOnly: true,
      description: 'Read messages and tool-call path associations from an imported agent session. Paginated to keep large agent sessions manageable.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: string('Agent session ID returned by search_conversations'), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      async run(input) {
        if (typeof input.id !== 'string') throw new Error('id is required');
        const item = conversations.store.read(input.id, { offset: Number(input.offset ?? 0), limit: Number(input.limit ?? 30) }); if (!item) throw new Error('No such imported agent session');
        return JSON.stringify(item);
      },
    },
  ];
}
