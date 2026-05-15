// aiPipeline.js — SpecKit pipeline supporting multiple AI providers + vision
'use strict';

// Supported providers: azure-openai | openai | anthropic | google | custom
class AIPipeline {
    constructor(getCfg) {
        this._cfg = getCfg;
    }

    /**
     * Build the user content for the first message.
     * If images are provided they are embedded as base64 alongside the text.
     * Returns a string (text-only) or an array (multimodal) depending on provider.
     */
    _buildUserContent(provider, textContent, images = []) {
        if (!images || !images.length) return textContent;

        if (provider === 'anthropic') {
            // Anthropic: images first, then text
            return [
                ...images.map(img => ({
                    type:   'image',
                    source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
                })),
                { type: 'text', text: textContent },
            ];
        }

        if (provider === 'google') {
            // Gemini uses parts format (handled inside _chatGoogle)
            return { _googleMultimodal: true, text: textContent, images };
        }

        // Azure OpenAI, OpenAI, custom — all use OpenAI image_url format
        return [
            { type: 'text', text: textContent },
            ...images.map(img => ({
                type:      'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
        ];
    }

    async _chat(messages, maxTokens = 2000) {
        const cfg      = this._cfg();
        const provider = cfg.get('aiProvider') || 'azure-openai';

        switch (provider) {
            case 'openai':    return this._chatOpenAI(cfg, messages, maxTokens);
            case 'anthropic': return this._chatAnthropic(cfg, messages, maxTokens);
            case 'google':    return this._chatGoogle(cfg, messages, maxTokens);
            case 'custom':    return this._chatCustom(cfg, messages, maxTokens);
            default:          return this._chatAzureOpenAI(cfg, messages, maxTokens);
        }
    }

    async _chatAzureOpenAI(cfg, messages, maxTokens) {
        const endpoint   = (cfg.get('azureOpenAiEndpoint') || '').replace(/\/$/, '');
        const apiKey     = cfg.get('azureOpenAiApiKey') || '';
        const deployment = cfg.get('azureOpenAiDeployment') || 'gpt-4o';
        const apiVersion = cfg.get('azureOpenAiApiVersion') || '2024-12-01-preview';

        if (!endpoint) throw new Error('jiraSpeckit.azureOpenAiEndpoint is not configured.');
        if (!apiKey)   throw new Error('jiraSpeckit.azureOpenAiApiKey is not configured.');

        const resp = await fetch(
            `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
                body:    JSON.stringify({ messages, max_tokens: maxTokens }),
                signal:  AbortSignal.timeout(90000),
            }
        );
        if (!resp.ok) throw new Error(`Azure OpenAI ${resp.status}: ${await resp.text()}`);
        return (await resp.json()).choices[0].message.content;
    }

    async _chatOpenAI(cfg, messages, maxTokens) {
        const apiKey = cfg.get('openAiApiKey') || '';
        const model  = cfg.get('openAiModel') || 'gpt-4o';

        if (!apiKey) throw new Error('jiraSpeckit.openAiApiKey is not configured.');

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body:    JSON.stringify({ model, messages, max_tokens: maxTokens }),
            signal:  AbortSignal.timeout(90000),
        });
        if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
        return (await resp.json()).choices[0].message.content;
    }

    async _chatAnthropic(cfg, messages, maxTokens) {
        const apiKey = cfg.get('anthropicApiKey') || '';
        const model  = cfg.get('anthropicModel') || 'claude-opus-4-5';

        if (!apiKey) throw new Error('jiraSpeckit.anthropicApiKey is not configured.');

        const systemMsg = messages.find(m => m.role === 'system');
        const chatMsgs  = messages.filter(m => m.role !== 'system');

        const body = { model, max_tokens: maxTokens, messages: chatMsgs };
        if (systemMsg) body.system = systemMsg.content;

        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         apiKey,
                'anthropic-version': '2023-06-01',
            },
            body:   JSON.stringify(body),
            signal: AbortSignal.timeout(90000),
        });
        if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
        return (await resp.json()).content[0].text;
    }

    async _chatGoogle(cfg, messages, maxTokens) {
        const apiKey = cfg.get('googleApiKey') || '';
        const model  = cfg.get('googleModel') || 'gemini-2.0-flash';

        if (!apiKey) throw new Error('jiraSpeckit.googleApiKey is not configured.');

        const systemMsg = messages.find(m => m.role === 'system');
        const chatMsgs  = messages.filter(m => m.role !== 'system').map(m => {
            // Handle multimodal google parts
            if (m.content && m.content._googleMultimodal) {
                const { text, images } = m.content;
                return {
                    role:  m.role === 'assistant' ? 'model' : 'user',
                    parts: [
                        ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
                        { text },
                    ],
                };
            }
            return {
                role:  m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
            };
        });

        const body = { contents: chatMsgs, generationConfig: { maxOutputTokens: maxTokens } };
        if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

        const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
                signal:  AbortSignal.timeout(90000),
            }
        );
        if (!resp.ok) throw new Error(`Google Gemini ${resp.status}: ${await resp.text()}`);
        return (await resp.json()).candidates[0].content.parts[0].text;
    }

    async _chatCustom(cfg, messages, maxTokens) {
        const endpoint = (cfg.get('customApiEndpoint') || '').replace(/\/$/, '');
        const apiKey   = cfg.get('customApiKey') || '';
        const model    = cfg.get('customApiModel') || '';

        if (!endpoint) throw new Error('jiraSpeckit.customApiEndpoint is not configured.');

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const body = { messages, max_tokens: maxTokens };
        if (model) body.model = model;

        const resp = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers,
            body:   JSON.stringify(body),
            signal: AbortSignal.timeout(90000),
        });
        if (!resp.ok) throw new Error(`Custom API ${resp.status}: ${await resp.text()}`);
        return (await resp.json()).choices[0].message.content;
    }

    /**
     * @param {string} key              Jira ticket key (e.g. PM-5)
     * @param {string} summary          Ticket summary
     * @param {string} description      Ticket description (text)
     * @param {string} workspaceContext Project context from workspaceScanner
     * @param {Array}  images           [{filename, mimeType, base64}] from jiraClient.downloadAttachments()
     */
    async resolve(key, summary, description, workspaceContext = '', images = []) {
        const provider = this._cfg().get('aiProvider') || 'azure-openai';
        const ctx = workspaceContext ? `\n\nCurrent project context:\n${workspaceContext}` : '';

        const hasImages = images && images.length > 0;
        const imageNote = hasImages
            ? `\n\nThis ticket includes ${images.length} attached screenshot(s)/image(s). Analyse them carefully and use them as the primary reference for what needs to be built or changed.`
            : '';

        // Stage 1 — Specification (vision-aware: images embedded here)
        const specUserText = `Jira ticket ${key}: "${summary}"\n\nDescription: ${description || '(none)'}${imageNote}${ctx}\n\nWrite a feature specification. If screenshots or UI images are provided, describe the exact UI elements, layout, colors, and interactions shown so they can be recreated precisely.`;
        const specUserContent = this._buildUserContent(provider, specUserText, hasImages ? images : []);

        const spec = await this._chat([
            {
                role:    'system',
                content: 'You are a senior software architect. Write a concise, clear feature specification. If UI screenshots are provided, describe every visible element, layout, color, and interaction in precise detail so a developer can recreate it exactly. Use plain text.',
            },
            { role: 'user', content: specUserContent },
        ]);

        // Stage 2 — Plan (text only from here — spec already captured image details)
        const plan = await this._chat([
            {
                role:    'system',
                content: 'You are a senior software engineer. Write a concise step-by-step technical implementation plan. If the spec describes a UI, include specific implementation steps for HTML, CSS, and JS. Plain text only.',
            },
            {
                role:    'user',
                content: `Feature spec:\n${spec}\n\nWrite a technical implementation plan.`,
            },
        ]);

        // Stage 3 — Tasks
        const tasks = await this._chat([
            {
                role:    'system',
                content: 'Convert a technical plan into a concrete checklist of coding tasks. Use "- [ ] Task description" format.',
            },
            {
                role:    'user',
                content: `Plan:\n${plan}\n\nWrite a task checklist.`,
            },
        ]);

        // Stage 4 — Implementation
        const solution = await this._chat([
            {
                role:    'system',
                content: 'Describe what was implemented and list files that were changed or created. On the last line write exactly: FILES_CHANGED: file1.ext, file2.ext',
            },
            {
                role:    'user',
                content: `Tasks:\n${tasks}${ctx}\n\nDescribe the implementation and list files changed.`,
            },
        ]);

        const filesMatch   = solution.match(/FILES_CHANGED:\s*(.+)/i);
        const filesChanged = filesMatch
            ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
            : [];

        // Stage 5 — Code generation: produce actual file contents
        // Re-include images so the AI can pixel-perfectly recreate the UI
        const codeGenUserText = [
            `Based on the specification and plan below, generate the COMPLETE, production-ready code for every file that needs to be created or modified.`,
            hasImages ? `UI screenshots are attached — match them exactly in layout, colors, fonts, spacing, and interactions.` : '',
            `\nFormat EACH file strictly as:\n===FILE:relative/path/to/file===\n(complete file content here)\n===ENDFILE===\n`,
            `Do not abbreviate or omit any code. Every file must be fully self-contained and correct.\n`,
            `Spec:\n${spec}\n\nPlan:\n${plan}\n\nTasks:\n${tasks}`,
        ].filter(Boolean).join('\n');

        const codeGenContent = this._buildUserContent(provider, codeGenUserText, hasImages ? images : []);

        const codeGenRaw = await this._chat(
            [
                {
                    role:    'system',
                    content: `You are an expert full-stack developer. Generate complete, working code files. ` +
                             `If UI screenshots are provided, replicate the exact visual design — ` +
                             `colours, layout, typography, spacing, icons, and interactions. ` +
                             `Output ONLY the file blocks in the ===FILE:path=== ... ===ENDFILE=== format. No explanations outside the blocks.`,
                },
                { role: 'user', content: codeGenContent },
            ],
            4000
        );

        // Parse ===FILE:path=== ... ===ENDFILE=== blocks
        const generatedFiles = [];
        const fileBlockRe = /===FILE:([^\n=]+)===\n([\s\S]*?)===ENDFILE===/g;
        let match;
        while ((match = fileBlockRe.exec(codeGenRaw)) !== null) {
            const filePath    = match[1].trim().replace(/^\/+/, '');  // strip leading slashes
            const fileContent = match[2];                              // preserve as-is
            generatedFiles.push({ path: filePath, content: fileContent });
        }

        const imageInfo = hasImages ? `\n\nImages analysed: ${images.map(i => i.filename).join(', ')}` : '';
        const fileList  = generatedFiles.map(f => f.path).join(', ');
        const comment   = `SpecKit Auto-Resolution${imageInfo}\n\nSpec:\n${spec}\n\nPlan:\n${plan}\n\nTasks:\n${tasks}\n\nImplementation:\n${solution}\n\nGenerated files: ${fileList || '(none)'}`;

        return { spec, plan, tasks, solution, filesChanged, generatedFiles, comment, imagesAnalysed: images.map(i => i.filename) };
    }
}

module.exports = { AIPipeline };
