import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { Message, ModelResponse } from './index';

/** Transport only: preserve tool IDs and malformed arguments for tool feedback. */
export function toLangChainMessages(messages: Message[]): BaseMessage[] {
  return messages.map(message => {
    const content = message.content_blocks ?? message.content;
    if (message.role === 'system') return new SystemMessage({ content });
    if (message.role === 'user') return new HumanMessage({ content });
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw Error('MODEL_TOOL_CALL_ID_REQUIRED');
      return new ToolMessage({ content, tool_call_id: message.tool_call_id });
    }
    return modelResponseToAIMessage({ text: message.content, calls: (message.tool_calls ?? []).map(call => ({
      id: call.id, name: call.function.name, arguments: call.function.arguments,
    })), usage: { input: null, output: null } }, content);
  });
}

export function fromLangChainMessages(messages: BaseMessage[]): Message[] {
  return messages.map(message => {
    const role = ({ system: 'system', human: 'user', ai: 'assistant', tool: 'tool' } as const)[message.type as 'system' | 'human' | 'ai' | 'tool'];
    if (!role) throw Error('MODEL_MODALITY_UNSUPPORTED');
    let content: string;
    let content_blocks: Message['content_blocks'];
    if (typeof message.content === 'string') content = message.content;
    else {
      content_blocks = message.content.map(part => {
        if (part.type === 'text' && typeof part.text === 'string') return { type: 'text' as const, text: part.text };
        if (part.type === 'image_url') {
          const image = part.image_url;
          const url = typeof image === 'string' ? image : image && typeof image === 'object' && 'url' in image ? image.url : undefined;
          if (typeof url === 'string') return { type: 'image_url' as const, image_url: { url } };
        }
        if (part.type === 'image') {
          if (typeof part.url === 'string') return { type: 'image_url' as const, image_url: { url: part.url } };
          if (typeof part.data === 'string' && typeof part.mime_type === 'string') return { type: 'image_url' as const, image_url: { url: `data:${part.mime_type};base64,${part.data}` } };
        }
        throw Error('MODEL_MODALITY_UNSUPPORTED');
      });
      content = content_blocks.filter(part => part.type === 'text').map(part => part.text).join('\n');
    }
    const result: Message = { role, content, ...(content_blocks ? { content_blocks } : {}) };
    if (message instanceof ToolMessage) result.tool_call_id = message.tool_call_id;
    if (message instanceof AIMessage) {
      const calls = [...message.tool_calls ?? [], ...message.invalid_tool_calls ?? []];
      const order=message.response_metadata.toolCallOrder;
      if(Array.isArray(order))calls.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
      if (calls.length) result.tool_calls = calls.map(call => ({
        id: call.id ?? '', type: 'function', function: { name: call.name ?? '', arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args) },
      }));
    }
    return result;
  });
}

export function modelResponseToAIMessage(response: ModelResponse, content: BaseMessage['content'] = response.text): AIMessage {
  const tool_calls: NonNullable<AIMessage['tool_calls']> = [];
  const invalid_tool_calls: NonNullable<AIMessage['invalid_tool_calls']> = [];
  for (const call of response.calls) {
    try {
      const args: unknown = JSON.parse(call.arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('MODEL_TOOL_ARGUMENTS_INVALID');
      tool_calls.push({ id: call.id, name: call.name, args: args as Record<string, unknown>, type: 'tool_call' });
    } catch {
      invalid_tool_calls.push({ id: call.id, name: call.name, args: call.arguments, error: 'MODEL_TOOL_ARGUMENTS_INVALID', type: 'invalid_tool_call' });
    }
  }
  const { input, output } = response.usage;
  return new AIMessage({ content, tool_calls, invalid_tool_calls,
    response_metadata: { usage: response.usage, toolCallOrder: response.calls.map(call=>call.id) },
    ...(input !== null && output !== null ? { usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output } } : {}),
  });
}

export function aiMessageToModelResponse(message: AIMessage): ModelResponse {
  const dto = fromLangChainMessages([message])[0];
  const usage = message.response_metadata.usage as ModelResponse['usage'] | undefined;
  return { text: dto.content, calls: (dto.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
    usage: usage ?? { input: message.usage_metadata?.input_tokens ?? null, output: message.usage_metadata?.output_tokens ?? null } };
}
