import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput, StructuredOutputMethodOptions } from '@langchain/core/language_models/base';
import { type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { RunnableLambda, type Runnable } from '@langchain/core/runnables';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { isSerializableSchema } from '@langchain/core/utils/standard_schema';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { generateStructured, getModelProfile, invoke } from '../models';
import type { Inference, Tool } from '../../../../packages/model/src/index';
import { fromLangChainMessages, modelResponseToAIMessage } from '../../../../packages/model/src/langchain';
import { assertPrivateAI } from './privacy';

export interface RelayModelOptions extends BaseChatModelCallOptions {
  operationId?: string;
  tools?: Tool[];
  maxTokens?: number;
  image?: string;
  tokenParameter?: Inference['tokenParameter'];
  /** Explicit formats are used by capability probes before capabilities are known. */
  schema?: Record<string, unknown>;
  jsonMode?: boolean;
  invalidCode?: string;
  capabilityProbe?: boolean;
}

/** LangChain interface over the existing encrypted, region-bound model adapter. */
export class RelayChatModel extends BaseChatModel<RelayModelOptions> {
  lc_serializable = false;
  constructor(
    private env: AppEnv,
    private modelId: string,
    private version: number,
    private operationId?: string,
    private runId: string | null = null,
    private graphId?: string,
    private graphGeneration?: number,
  ) {
    super({ maxRetries: 0, disableStreaming: true });
    assertPrivateAI();
  }
  _llmType() { return 'taskrelay-us-egress'; }

  bindTools(tools: BindToolsInput[], kwargs: Partial<RelayModelOptions> = {}) {
    const definitions = tools.map(tool => {
      const converted = convertToOpenAITool(tool);
      return { name: converted.function.name, description: converted.function.description ?? '', parameters: converted.function.parameters ?? {} };
    });
    return this.withConfig({ ...kwargs, tools: definitions });
  }

  async _generate(messages: BaseMessage[], options: this['ParsedCallOptions']): Promise<ChatResult> {
    assertPrivateAI();
    options.signal?.throwIfAborted();
    const choice = options.tool_choice;
    if (choice && !['auto', 'any', 'required', 'none'].includes(String(choice))) throw Error('MODEL_TOOL_CHOICE_UNSUPPORTED');
    const wireMessages=fromLangChainMessages(messages);
    if(!options.capabilityProbe){
      const {profile}=await getModelProfile(this.env,this.modelId,this.version);
      if((options.image||wireMessages.some(message=>message.content_blocks?.some(part=>part.type==='image_url')))&&!profile.capabilities.vision)throw Error('VISION_NOT_SUPPORTED');
      if(options.tools?.length&&choice!=='none'&&!profile.capabilities.tools)throw Error('TOOLS_UNSUPPORTED');
      if((options.schema||options.jsonMode)&&profile.capabilities.structured==='none')throw Error('STRUCTURED_OUTPUT_REQUIRED');
      if(options.schema&&profile.capabilities.structured!=='schema')throw Error('STRUCTURED_SCHEMA_REQUIRED');
    }
    const response = await invoke(this.env, this.modelId, this.version, {
      messages: wireMessages,
      ...(choice !== 'none' && options.tools?.length ? { tools: options.tools, toolChoice: choice === 'any' || choice === 'required' ? 'required' : 'auto' } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.image ? { image: options.image } : {}),
      ...(options.tokenParameter ? { tokenParameter: options.tokenParameter } : {}),
      ...(options.schema ? { schema: options.schema } : {}),
      ...(options.jsonMode ? { jsonMode: true } : {}),
    }, this.runId, options.operationId ?? this.operationId, this.graphId, this.graphGeneration);
    options.signal?.throwIfAborted();
    return { generations: [{ text: response.text, message: modelResponseToAIMessage(response) }], llmOutput: { usage: response.usage } };
  }

  withStructuredOutput<Output extends Record<string, any> = Record<string, any>>(schema: unknown, config?: StructuredOutputMethodOptions<false>): Runnable<BaseLanguageModelInput, Output, RelayModelOptions>;
  withStructuredOutput<Output extends Record<string, any> = Record<string, any>>(schema: unknown, config?: StructuredOutputMethodOptions<true>): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: Output }, RelayModelOptions>;
  withStructuredOutput<Output extends Record<string, any> = Record<string, any>>(schema: unknown, config: StructuredOutputMethodOptions<boolean> = {}): Runnable<BaseLanguageModelInput, Output | { raw: BaseMessage; parsed: Output }, RelayModelOptions> {
    if (config.method && !['jsonMode', 'jsonSchema'].includes(config.method)) throw Error('MODEL_STRUCTURED_METHOD_UNSUPPORTED');
    let json: Record<string, unknown>;
    let validate: (value: unknown) => Output | Promise<Output>;
    if (schema instanceof z.ZodType) {
      json = z.toJSONSchema(schema);
      validate = value => schema.parse(value) as Output;
    } else if (isSerializableSchema<Output>(schema)) {
      json = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
      validate = async value => {
        const result = await schema['~standard'].validate(value);
        if (result.issues) throw Error('MODEL_INVALID_JSON');
        return result.value;
      };
    } else {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw Error('MODEL_SCHEMA_INVALID');
      json = schema as Record<string, unknown>;
      const validator = z.fromJSONSchema(json, { registry: z.registry() });
      validate = value => validator.parse(value) as Output;
    }
    return RunnableLambda.from<BaseLanguageModelInput, Output | { raw: BaseMessage; parsed: Output }, RelayModelOptions>(async (input, options) => {
      assertPrivateAI();
      options?.signal?.throwIfAborted();
      const messages = RelayChatModel._convertInputToPromptValue(input).toChatMessages();
      const wireMessages=fromLangChainMessages(messages);
      if(options?.image||wireMessages.some(message=>message.content_blocks?.some(part=>part.type==='image_url'))){
        const {profile}=await getModelProfile(this.env,this.modelId,this.version);
        if(!profile.capabilities.vision)throw Error('VISION_NOT_SUPPORTED');
      }
      const result = await generateStructured(this.env, this.modelId, this.version, json, validate,
        wireMessages, this.runId, options?.invalidCode ?? 'MODEL_INVALID_JSON',
        options?.operationId ?? this.operationId, this.graphId,
        { ...(options?.image ? { image: options.image } : {}), ...(config.method ? { format: config.method === 'jsonMode' ? 'json' : 'schema' } : {}) }, this.graphGeneration);
      options?.signal?.throwIfAborted();
      return config.includeRaw ? { raw: modelResponseToAIMessage(result.response), parsed: result.data } : result.data;
    });
  }
}
