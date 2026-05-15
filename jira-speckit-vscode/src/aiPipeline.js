// aiPipeline.js — SpecKit pipeline supporting multiple AI providers
'use strict';

// Supported providers: azure-openai | openai | anthropic | google | custom
class AIPipeline {
    constructor(getCfg) {
        this._cfg = getCfg;
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

        // Anthropic separates system from user/assistant messages
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

        // Convert OpenAI-style messages to Gemini format
        const systemMsg = messages.find(m => m.role === 'system');
        const chatMsgs  = messages.filter(m => m.role !== 'system').map(m => ({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));

        const body = {
            contents:          chatMsgs,
            generationConfig:  { maxOutputTokens: maxTokens },
        };
        if (systemMsg) {
            body.systemInstruction = { parts: [{ text: systemMsg.content }] };
        }

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

        // Assumes OpenAI-compatible REST API (works with Ollama, vLLM, LM Studio, company APIs)
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

    async resolve(key, summary, description, workspaceContext = '') {
        const ctx = workspaceContext
            ? `\n\nCurrent project context:\n${workspaceContext}`
            : '';

        // Stage 1 — Specification
        const spec = await this._chat([
            {
                role: 'system',
                content: 'You are a senior software architect. Write a concise, clear feature specification. Be specific and actionable. Use plain text, no markdown headers.',
            },
            {
                role: 'user',
                content: `Jira ticket ${key}: "${summary}"\n\nDescription: ${description || '(none)'}${ctx}\n\nWrite a feature specification.`,
            },
        ]);

        // Stage 2 — Plan
        const plan = await this._chat([
            {
                role: 'system',
                content: 'You are a senior software engineer. Write a concise step-by-step technical implementation plan. Plain text only.',
            },
            {
                role: 'user',
                content: `Feature spec:\n${spec}\n\nWrite a technical implementation plan.`,
            },
        ]);

        // Stage 3 — Tasks
        const tasks = await this._chat([
            {
                role: 'system',
                content: 'Convert a technical plan into a concrete checklist of coding tasks. Use "- [ ] Task description" format.',
            },
            {
                role: 'user',
                content: `Plan:\n${plan}\n\nWrite a task checklist.`,
            },
        ]);

        // Stage 4 — Implementation summary
        const solution = await this._chat([
            {
                role: 'system',
                content: 'Describe what was implemented and list files that were changed or created. On the last line write exactly: FILES_CHANGED: file1.ext, file2.ext',
            },
            {
                role: 'user',
                content: `Tasks:\n${tasks}${ctx}\n\nDescribe the implementation and list files changed.`,
            },
        ]);

        const filesMatch   = solution.match(/FILES_CHANGED:\s*(.+)/i);
        const filesChanged = filesMatch
            ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
            : [];

        const comment = `SpecKit Auto-Resolution\n\nSpec:\n${spec}\n\nPlan:\n${plan}\n\nTasks:\n${tasks}\n\nImplementation:\n${solution}`;

        return { spec, plan, tasks, solution, filesChanged, comment };
    }
}

module.exports = { AIPipeline };
