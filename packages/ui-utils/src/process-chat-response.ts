import { LanguageModelV1FinishReason } from '@ai-sdk/provider';
import { generateId as generateIdFunction } from '@ai-sdk/provider-utils';
import {
  calculateLanguageModelUsage,
  LanguageModelUsage,
} from './duplicated/usage';
import { parsePartialJson } from './parse-partial-json';
import { processDataStream } from './process-data-stream';
import type {
  JSONValue,
  ReasoningUIPart,
  TextUIPart,
  ToolInvocation,
  ToolInvocationUIPart,
  UIMessage,
  UseChatOptions,
} from './types';

export async function processChatResponse({
  stream,
  update,
  onToolCall,
  onFinish,
  generateId = generateIdFunction,
  getCurrentDate = () => new Date(),
  lastMessage,
}: {
  stream: ReadableStream<Uint8Array>;
  update: (options: {
    message: UIMessage;
    data: JSONValue[] | undefined;
    replaceLastMessage: boolean;
  }) => void;
  onToolCall?: UseChatOptions['onToolCall'];
  onFinish?: (options: {
    message: UIMessage | undefined;
    finishReason: LanguageModelV1FinishReason;
    usage: LanguageModelUsage;
  }) => void;
  generateId?: () => string;
  getCurrentDate?: () => Date;
  lastMessage: UIMessage | undefined;
}) {
  console.log('Custom processChatResponse Invoked', lastMessage);
  let replaceLastMessage = lastMessage?.role === 'assistant';
  console.log('replaceLastMessage', replaceLastMessage);
  let step = replaceLastMessage
    ? 1 +
      // find max step in existing tool invocations:
      (lastMessage?.toolInvocations?.reduce((max, toolInvocation) => {
        return Math.max(max, toolInvocation.step ?? 0);
      }, 0) ?? 0)
    : 0;

  let message: UIMessage = replaceLastMessage && lastMessage
    ? structuredClone(lastMessage)
    : {
        id: generateId(),
        createdAt: getCurrentDate(),
        role: 'assistant',
        content: '',
        parts: [],
      };
  
  // Track the current message ID
  let currentMessageId = message.id;

  let currentTextPart: TextUIPart | undefined = undefined;
  let currentReasoningPart: ReasoningUIPart | undefined = undefined;
  let currentReasoningTextDetail:
    | { type: 'text'; text: string; signature?: string }
    | undefined = undefined;

  function updateToolInvocationPart(
    toolCallId: string,
    invocation: ToolInvocation,
  ) {
    const part = message.parts.find(
      part =>
        part.type === 'tool-invocation' &&
        part.toolInvocation.toolCallId === toolCallId,
    ) as ToolInvocationUIPart | undefined;

    if (part != null) {
      part.toolInvocation = invocation;
    } else {
      message.parts.push({
        type: 'tool-invocation',
        toolInvocation: invocation,
      });
    }
  }

  const data: JSONValue[] = [];

  // keep list of current message annotations for message
  let messageAnnotations: JSONValue[] | undefined = replaceLastMessage
    ? lastMessage?.annotations
    : undefined;

  // keep track of partial tool calls
  const partialToolCalls: Record<
    string,
    { text: string; step: number; index: number; toolName: string }
  > = {};

  let usage: LanguageModelUsage = {
    completionTokens: Number.NaN,
    promptTokens: Number.NaN,
    totalTokens: Number.NaN,
  };
  let finishReason: LanguageModelV1FinishReason = 'unknown';

  function execUpdate() {
    // make a copy of the data array to ensure UI is updated (SWR)
    const copiedData = [...data];

    // keeps the currentMessage up to date with the latest annotations,
    // even if annotations preceded the message creation
    if (messageAnnotations?.length) {
      message.annotations = messageAnnotations;
    }

    const copiedMessage = {
      // deep copy the message to ensure that deep changes (msg attachments) are updated
      // with SolidJS. SolidJS uses referential integration of sub-objects to detect changes.
      ...structuredClone(message),
      // add a revision id to ensure that the message is updated with SWR. SWR uses a
      // hashing approach by default to detect changes, but it only works for shallow
      // changes. This is why we need to add a revision id to ensure that the message
      // is updated with SWR (without it, the changes get stuck in SWR and are not
      // forwarded to rendering):
      revisionId: generateId(),
    } as UIMessage;
    
    update({
      message: copiedMessage,
      data: copiedData,
      replaceLastMessage,
    });
  }
  
  // Function to create a new message when detecting a new message ID
  function createNewMessage(messageId: string) {
    // Send the current message with its final state
    execUpdate();
    
    // Create a new message
    message = {
      id: messageId,
      createdAt: getCurrentDate(),
      role: 'assistant',
      content: '',
      parts: [],
    };
    
    // Update the current message ID
    currentMessageId = messageId;
    
    // Reset state for the new message
    currentTextPart = undefined;
    currentReasoningPart = undefined;
    currentReasoningTextDetail = undefined;
    step = 0;
    // messageAnnotations = undefined;
    
    // New message should not replace the previous one
    replaceLastMessage = false;
  }

  await processDataStream({
    stream,
    onTextPart(value) {
      if (currentTextPart == null) {
        currentTextPart = {
          type: 'text',
          text: value,
        };
        message.parts.push(currentTextPart);
      } else {
        currentTextPart.text += value;
      }

      message.content += value;
      execUpdate();
    },
    onReasoningPart(value) {
      if (currentReasoningTextDetail == null) {
        currentReasoningTextDetail = { type: 'text', text: value };
        if (currentReasoningPart != null) {
          currentReasoningPart.details.push(currentReasoningTextDetail);
        }
      } else {
        currentReasoningTextDetail.text += value;
      }

      if (currentReasoningPart == null) {
        currentReasoningPart = {
          type: 'reasoning',
          reasoning: value,
          details: [currentReasoningTextDetail],
        };
        message.parts.push(currentReasoningPart);
      } else {
        currentReasoningPart.reasoning += value;
      }

      message.reasoning = (message.reasoning ?? '') + value;

      execUpdate();
    },
    onReasoningSignaturePart(value) {
      if (currentReasoningTextDetail != null) {
        currentReasoningTextDetail.signature = value.signature;
      }
    },
    onRedactedReasoningPart(value) {
      if (currentReasoningPart == null) {
        currentReasoningPart = {
          type: 'reasoning',
          reasoning: '',
          details: [],
        };
        message.parts.push(currentReasoningPart);
      }

      currentReasoningPart.details.push({
        type: 'redacted',
        data: value.data,
      });

      currentReasoningTextDetail = undefined;

      execUpdate();
    },
    onSourcePart(value) {
      message.parts.push({
        type: 'source',
        source: value,
      });

      execUpdate();
    },
    onToolCallStreamingStartPart(value) {
      if (message.toolInvocations == null) {
        message.toolInvocations = [];
      }

      // add the partial tool call to the map
      partialToolCalls[value.toolCallId] = {
        text: '',
        step,
        toolName: value.toolName,
        index: message.toolInvocations.length,
      };

      const invocation = {
        state: 'partial-call',
        step,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        args: undefined,
      } as const;

      message.toolInvocations.push(invocation);

      updateToolInvocationPart(value.toolCallId, invocation);

      execUpdate();
    },
    onToolCallDeltaPart(value) {
      const partialToolCall = partialToolCalls[value.toolCallId];

      partialToolCall.text += value.argsTextDelta;

      const { value: partialArgs } = parsePartialJson(partialToolCall.text);

      const invocation = {
        state: 'partial-call',
        step: partialToolCall.step,
        toolCallId: value.toolCallId,
        toolName: partialToolCall.toolName,
        args: partialArgs,
      } as const;

      if (message.toolInvocations && partialToolCall.index < message.toolInvocations.length) {
        message.toolInvocations[partialToolCall.index] = invocation;
      }

      updateToolInvocationPart(value.toolCallId, invocation);

      execUpdate();
    },
    async onToolCallPart(value) {
      const invocation = {
        state: 'call',
        step,
        ...value,
      } as const;

      if (partialToolCalls[value.toolCallId] != null) {
        // change the partial tool call to a full tool call
        if (message.toolInvocations && partialToolCalls[value.toolCallId].index < message.toolInvocations.length) {
          message.toolInvocations[partialToolCalls[value.toolCallId].index] = invocation;
        }
      } else {
        if (message.toolInvocations == null) {
          message.toolInvocations = [];
        }

        message.toolInvocations.push(invocation);
      }

      updateToolInvocationPart(value.toolCallId, invocation);

      execUpdate();

      // invoke the onToolCall callback if it exists. This is blocking.
      // In the future we should make this non-blocking, which
      // requires additional state management for error handling etc.
      if (onToolCall) {
        const result = await onToolCall({ toolCall: value });
        if (result != null) {
          const invocation = {
            state: 'result',
            step,
            ...value,
            result,
          } as const;

          // store the result in the tool invocation
          if (message.toolInvocations && message.toolInvocations.length > 0) {
            message.toolInvocations[message.toolInvocations.length - 1] = invocation;
          }

          updateToolInvocationPart(value.toolCallId, invocation);

          execUpdate();
        }
      }
    },
    onToolResultPart(value) {
      const toolInvocations = message.toolInvocations;

      if (toolInvocations == null) {
        throw new Error('tool_result must be preceded by a tool_call');
      }

      // find if there is any tool invocation with the same toolCallId
      // and replace it with the result
      const toolInvocationIndex = toolInvocations.findIndex(
        invocation => invocation.toolCallId === value.toolCallId,
      );

      if (toolInvocationIndex === -1) {
        throw new Error(
          'tool_result must be preceded by a tool_call with the same toolCallId',
        );
      }

      const invocation = {
        ...toolInvocations[toolInvocationIndex],
        state: 'result' as const,
        ...value,
      } as const;

      toolInvocations[toolInvocationIndex] = invocation;

      updateToolInvocationPart(value.toolCallId, invocation);

      execUpdate();
    },
    onDataPart(value) {
      data.push(...value);
      execUpdate();
    },
    onMessageAnnotationsPart(value) {
      if (messageAnnotations == null) {
        messageAnnotations = [...value];
      } else {
        messageAnnotations.push(...value);
      }

      execUpdate();
    },
    onFinishStepPart(value) {
      step += 1;

      // reset the current text and reasoning parts
      currentTextPart = value.isContinued ? currentTextPart : undefined;
      currentReasoningPart = undefined;
      currentReasoningTextDetail = undefined;
    },
    onStartStepPart(value) {
      // Check if a new message ID has been sent
      if (value.messageId && value.messageId !== currentMessageId) {
        // Create a new message with the new ID
        createNewMessage(value.messageId);
      } else if (!replaceLastMessage) {
        // For existing behavior: keep message id stable when we are updating an existing message
        message.id = value.messageId;
      }
    },
    onFinishMessagePart(value) {
      finishReason = value.finishReason;
      if (value.usage != null) {
        usage = calculateLanguageModelUsage(value.usage);
      }
    },
    onErrorPart(error) {
      throw new Error(error);
    },
  });

  onFinish?.({ message, finishReason, usage });
}
