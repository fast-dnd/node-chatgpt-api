import './fetch-polyfill.js';
import crypto from 'crypto';
import Keyv from 'keyv';
import { fetchEventSource } from '@waylaidwanderer/fetch-event-source';

const OPENROUTER_DEFAULT_MODEL = 'mistralai/mistral-7b-instruct';

export default class OpenRouterAiClient {
    constructor(
        apiKey,
        options = {},
        cacheOptions = {},
    ) {
        this.apiKey = apiKey;

        cacheOptions.namespace = cacheOptions.namespace || 'openrouter';
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

        if (this.options.apiKey) {
            this.apiKey = this.options.apiKey;
        }
        const modelOptions = this.options.modelOptions || {};
        this.modelOptions = {
            ...modelOptions,
            // set some good defaults (check for undefined in some cases because they may be 0)
            model: modelOptions.model || OPENROUTER_DEFAULT_MODEL,
            temperature: 0.1,
            top_p: 0.9,
            presence_penalty: 0.25,
        };
        this.startToken = '||>';
        this.endToken = '';
        this.userLabel = this.options.userLabel || 'user';
        this.openrouterLabel = this.options.openrouterLabel || 'system';
        this.completionsUrl = 'https://openrouter.ai/api/v1/chat/completions';
        return this;
    }

    // eslint-disable-next-line no-unused-vars
    async getCompletion(input, onProgress) {
        const modelOptions = { ...this.modelOptions };
        if (typeof onProgress === 'function') {
            modelOptions.stream = true;
        }
        modelOptions.prompt = input;
        const url = this.completionsUrl;
        const opts = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(modelOptions),
        };
        opts.headers.Authorization = `Bearer ${this.apiKey}`;

        if (this.options.headers) {
            opts.headers = { ...opts.headers, ...this.options.headers };
        }

        console.log(`Current options: ${JSON.stringify(this.modelOptions)}`);
        if (modelOptions.stream) {
            // eslint-disable-next-line no-async-promise-executor
            return new Promise(async (resolve, reject) => {
                try {
                    let done = false;
                    await fetchEventSource(url, {
                        ...opts,
                        async onopen(response) {
                            if (response.status === 200) {
                                return;
                            }
                            let error;
                            try {
                                const body = await response.text();
                                error = new Error(`Failed to send message. HTTP ${response.status} - ${body}`);
                                error.status = response.status;
                                error.json = JSON.parse(body);
                            } catch {
                                error = error || new Error(`Failed to send message. HTTP ${response.status}`);
                            }
                            throw error;
                        },
                        onclose() {
                            // workaround for private API not sending [DONE] event
                            if (!done) {
                                onProgress('[DONE]');
                                resolve();
                            }
                        },
                        onerror(err) {
                            // rethrow to stop the operation
                            throw err;
                        },
                        onmessage(message) {
                            if (!message.data || message.event === 'ping') {
                                return;
                            }
                            if (message.data === '[DONE]') {
                                onProgress('[DONE]');
                                console.log('Received final [DONE] chunk for prompt.');
                                resolve();
                                done = true;
                                return;
                            }
                            onProgress(JSON.parse(message.data));
                        },
                    });
                } catch (err) {
                    reject(err);
                }
            });
        }
        const response = await fetch(
            url,
            {
                ...opts,
            },
        );
        if (response.status !== 200) {
            const body = await response.text();
            const error = new Error(`Failed to send message. HTTP ${response.status} - ${body}`);
            error.status = response.status;
            try {
                error.json = JSON.parse(body);
            } catch {
                error.body = body;
            }
            throw error;
        }
        return response.json();
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
            role: 'user',
            content: message,
            message,
        };
        conversation.messages.push(userMessage);

        console.log(`Building prompt. ConversationId: ${conversationId}, ParentId: ${parentMessageId}`);
        // eslint-disable-next-line no-unused-vars
        const { prompt: payload, context } = await this.buildPrompt(
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
                payload,
                (progressMessage) => {
                    if (progressMessage === '[DONE]') {
                        return;
                    }
                    const token = progressMessage.choices[0]?.text;
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
                payload,
                null,
            );
            reply = result.choices[0].text;
        }
        reply = reply.trim();
        const lastSentenceEnd = Math.max(
            reply.lastIndexOf('.'),
            reply.lastIndexOf('!'),
            reply.lastIndexOf('?'),
            reply.lastIndexOf(')'),
        );
        const trimmedReply = lastSentenceEnd !== -1 ? reply.slice(0, lastSentenceEnd + 1) : reply;

        const replyMessage = {
            id: crypto.randomUUID(),
            parentMessageId: userMessage.id,
            role: 'system',
            content: trimmedReply,
            message: trimmedReply,
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
        let promptBody = '';
        const context = [];
        const promptSuffix = `${this.startToken}system:\n`; // Prompt ChatGPT to respond.
        // Iterate backwards through the messages, adding them to the prompt until we reach the max token count.
        // Do this within a recursive async function so that it doesn't block the event loop for too long.
        const lastUserIteration = orderedMessages.length - 1;
        const buildPromptBody = async (iteration) => {
            if (orderedMessages.length > 0) {
                const message = orderedMessages.pop();
                const roleLabel = message.role === 'user' ? 'user' : 'system';
                /* Pop logic explanation:
                [iteration < lastUserIteration -> I want first message on bottom bobInto to be there]
                [iteration > 0 -> I want last User message to be there ]
                */
                if (roleLabel === 'user' && iteration > 0 && iteration < lastUserIteration) {
                    message.content = 'Continue the story';
                    message.message = 'Continue the story';
                }
                const messageString = `${this.startToken}${roleLabel}:\n${message.content}${this.endToken}\n`;
                promptBody = `${messageString}${promptBody}`;
                context.unshift(message);
                // wait for next tick to avoid blocking the event loop
                await new Promise(resolve => setImmediate(resolve));
                return buildPromptBody(iteration + 1);
            }
            return true;
        };

        await buildPromptBody(0);
        const prompt = `${promptBody}${promptSuffix}`;
        return { prompt, context };
    }

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
