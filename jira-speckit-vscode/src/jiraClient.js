// jiraClient.js — direct Jira REST API calls (no backend server needed)
'use strict';

class JiraClient {
    constructor(getCfg) {
        this._cfg = getCfg;
    }

    _headers() {
        const cfg   = this._cfg();
        const email = cfg.get('jiraEmail') || '';
        const token = cfg.get('jiraApiToken') || '';
        const auth  = Buffer.from(`${email}:${token}`).toString('base64');
        return {
            'Authorization': `Basic ${auth}`,
            'Accept':        'application/json',
            'Content-Type':  'application/json',
        };
    }

    _base()    { return (this._cfg().get('jiraBaseUrl') || '').replace(/\/$/, ''); }
    _project() { return this._cfg().get('jiraProjectKey') || ''; }

    _assertConfigured() {
        const cfg = this._cfg();
        if (!this._base())          throw new Error('jiraSpeckit.jiraBaseUrl is not set. Open Settings and configure Jira SpecKit.');
        if (!cfg.get('jiraEmail'))  throw new Error('jiraSpeckit.jiraEmail is not set. Open Settings and configure Jira SpecKit.');
        if (!cfg.get('jiraApiToken')) throw new Error('jiraSpeckit.jiraApiToken is not set. Open Settings and configure Jira SpecKit.');
        if (!this._project())       throw new Error('jiraSpeckit.jiraProjectKey is not set. Open Settings and configure Jira SpecKit.');
    }

    async fetchOpenTickets() {
        this._assertConfigured();
        const jql  = encodeURIComponent(`project = "${this._project()}" AND statusCategory != Done ORDER BY created DESC`);
        const resp = await fetch(
            `${this._base()}/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=summary,description,status`,
            { headers: this._headers(), signal: AbortSignal.timeout(15000) }
        );
        if (!resp.ok) throw new Error(`Jira returned ${resp.status} — check your email and API token in settings.`);
        return (await resp.json()).issues || [];
    }

    async fetchDoneTickets() {
        this._assertConfigured();
        const jql  = encodeURIComponent(`project = "${this._project()}" AND statusCategory = Done ORDER BY updated DESC`);
        const resp = await fetch(
            `${this._base()}/rest/api/3/search/jql?jql=${jql}&maxResults=50&fields=summary,status,resolutiondate,updated`,
            { headers: this._headers(), signal: AbortSignal.timeout(15000) }
        );
        if (!resp.ok) throw new Error(`Jira returned ${resp.status}`);
        return (await resp.json()).issues || [];
    }

    async postComment(ticketId, text) {
        const body = {
            body: {
                type: 'doc', version: 1,
                content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            },
        };
        await fetch(`${this._base()}/rest/api/3/issue/${ticketId}/comment`, {
            method:  'POST',
            headers: this._headers(),
            body:    JSON.stringify(body),
            signal:  AbortSignal.timeout(15000),
        });
    }

    async transitionToDone(ticketId) {
        const resp = await fetch(
            `${this._base()}/rest/api/3/issue/${ticketId}/transitions`,
            { headers: this._headers(), signal: AbortSignal.timeout(15000) }
        );
        const data = await resp.json();
        const done = data.transitions?.find(t => t.to?.statusCategory?.key === 'done');
        if (!done) return;
        await fetch(`${this._base()}/rest/api/3/issue/${ticketId}/transitions`, {
            method:  'POST',
            headers: this._headers(),
            body:    JSON.stringify({ transition: { id: done.id } }),
            signal:  AbortSignal.timeout(15000),
        });
    }
}

module.exports = { JiraClient };
