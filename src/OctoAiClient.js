import './fetch-polyfill.js';
import crypto from 'crypto';
import Keyv from 'keyv';
import { Client } from '@octoai/client';

const OCTOAI_DEFAULT_MODEL = 'mixtral-8x7b-instruct-fp16';
const client = new Client(process.env.OCTOAI_API_KEY);

export default class OctoAIClient {
    constructor(
        apiKey,
        options = {},
        cacheOptions = {},
    ) {
        this.apiKey = apiKey;

        cacheOptions.namespace = cacheOptions.namespace || 'octoAI';
        this.conversationsCache = new Keyv(cacheOptions);

        this.setOptions(options);
    }

    setOptions(options) {
        if (this.options && !this.options.replaceOptions) {
            // nested options aren't spread properly, so we need to do this manually
            this.options.modelOptions = {
                ...this.options.modelOptions,
                ...options.modelOptions,
            };
            delete options.modelOptions;
            // now we can merge options
            this.options = {
                ...this.options,
                ...options,
            };
        } else {
            this.options = options;
        }

        if (this.options.openaiApiKey) {
            this.apiKey = this.options.openaiApiKey;
        }

        const modelOptions = this.options.modelOptions || {};
        this.modelOptions = {
            ...modelOptions,
            // set some good defaults (check for undefined in some cases because they may be 0)
            model: modelOptions.model || OCTOAI_DEFAULT_MODEL,
            temperature: 0.1,
            top_p: 0.9,
            presence_penalty: 0.25,
        };

        this.userLabel = this.options.userLabel || 'user';
        this.octoAiLable = this.options.octoAiLabel || 'system';
        return this;
    }

    // eslint-disable-next-line no-unused-vars
    async getCompletion(input, onProgress) {
        const modelOptions = { ...this.modelOptions };
        if (typeof onProgress === 'function') {
            modelOptions.stream = true;
        } else {
            modelOptions.stream = false;
        }
        console.log(`Current options: ${JSON.stringify(modelOptions)}`);
        const response = await client.chat.completions.create({
            messages: input,
            model: modelOptions.model,
            max_tokens: modelOptions.max_tokens,
            presence_penalty: 0.1,
            temperature: 0.1,
            top_p: 0.1,
            stream: modelOptions.stream,
        });
        if (modelOptions.stream) {
            for await (const chunk of response) {
                onProgress(chunk);
            }
        }
        return response;
    }

    async sendMessage(
        message,
        opts = {},
    ) {
        if (opts.clientOptions && typeof opts.clientOptions === 'object') {
            this.setOptions(opts.clientOptions);
        }

        const conversationId = opts.conversationId || crypto.randomUUID();
        const parentMessageId = opts.parentMessageId || crypto.randomUUID();
        console.log(`Send message. ConversationId: ${conversationId}, ParentId: ${parentMessageId}`);
        let conversation = typeof opts.conversation === 'object'
            ? opts.conversation
            : await this.conversationsCache.get(conversationId);

        if (!conversation) {
            conversation = {
                messages: [],
                createdAt: Date.now(),
            };
        }

        const userMessage = {
            id: crypto.randomUUID(),
            parentMessageId,
            role: opts.clientOptions.userLabel,
            content: message,
        };
        conversation.messages.push(userMessage);

        console.log(`Building prompt. ConversationId: ${conversationId}, ParentId: ${parentMessageId}`);
        const { context } = await this.buildPrompt(
            conversation.messages,
            userMessage.id,
            {
                promptPrefix: opts.promptPrefix,
            },
        );
        console.log(`Prompt built. ConversationId: ${conversationId}, ParentId: ${parentMessageId}`);
        let reply = '';
        let result = null;
        if (typeof opts.onProgress === 'function') {
            await this.getCompletion(
                context,
                (progressMessage) => {
                    if (progressMessage === '[DONE]') {
                        return;
                    }
                    const token = progressMessage.choices[0]?.delta.content;
                    // first event's delta content is always undefined
                    if (!token) {
                        return;
                    }
                    if (this.options.debug) {
                        console.debug(token);
                    }
                    if (token === this.endToken) {
                        return;
                    }
                    opts.onProgress(token);
                    reply += token;
                },
            );
        } else {
            result = await this.getCompletion(
                context,
                null,
            );
            reply = result.choices[0].message.content;
        }
        reply = reply.trim();

        const replyMessage = {
            id: crypto.randomUUID(),
            parentMessageId: userMessage.id,
            role: opts.clientOptions.octoAiLabel,
            content: reply,
        };
        conversation.messages.push(replyMessage);
        await this.conversationsCache.set(conversationId, conversation);
        return {
            response: replyMessage.content,
            conversationId,
            messageId: replyMessage.id,
            details: result || {},
        };
    }

    async buildPrompt(messages, parentMessageId) {
        const orderedMessages = this.constructor.getMessagesForConversation(messages, parentMessageId);

        const context = [];

        // Iterate backwards through the messages, adding them to the prompt until we reach the max token count.
        // Do this within a recursive async function so that it doesn't block the event loop for too long.
        const lastUserIteration = orderedMessages.length - 1;
        const buildPromptBody = async (iteration) => {
            if (orderedMessages.length > 0) {
                const message = orderedMessages.pop();
                const roleLabel = message.role === this.userLabel ? this.userLabel : this.octoAiLable;
                /* Pop logic explanation:
                [iteration < lastUserIteration -> I want first message on bottom bobInto to be there]
                [iteration > 0 -> I want last User message to be there ]
                */
                if (roleLabel === this.userLabel && iteration > 0 && iteration < lastUserIteration) {
                    message.content = 'Some rules/instructions on how DM should continue the story...';
                }
                context.unshift(message);
                // wait for next tick to avoid blocking the event loop
                await new Promise(resolve => setImmediate(resolve));
                return buildPromptBody(iteration + 1);
            }
            return true;
        };

        await buildPromptBody(0);
        return { context };
    }

    /**
     * Iterate through messages, building an array based on the parentMessageId.
     * Each message has an id and a parentMessageId. The parentMessageId is the id of the message that this message is a reply to.
     * @param messages
     * @param parentMessageId
     * @returns {*[]} An array containing the messages in the order they should be displayed, starting with the root message.
     */
    static getMessagesForConversation(messages, parentMessageId) {
        const orderedMessages = [];
        let currentMessageId = parentMessageId;
        while (currentMessageId) {
            // eslint-disable-next-line no-loop-func
            const message = messages.find(m => m.id === currentMessageId);
            if (!message) {
                break;
            }
            orderedMessages.unshift(message);
            currentMessageId = message.parentMessageId;
        }

        return orderedMessages;
    }
}
