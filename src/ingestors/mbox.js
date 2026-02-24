// MBOX email ingestor
// Parses .mbox files (Gmail Takeout, Thunderbird exports, etc.)
// Only indexes threads where the user has sent at least one message.

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { BaseIngestor } from './base.js';

export class MboxIngestor extends BaseIngestor {
  constructor(myEmails = []) {
    super();
    // Email addresses that belong to "me" — threads without my participation get skipped
    this.myEmails = new Set(myEmails.map(e => e.toLowerCase().trim()));
  }

  canHandle(path) {
    return path.endsWith('.mbox');
  }

  async ingest(path) {
    const pathStat = await stat(path);
    if (!pathStat.isFile()) throw new Error(`MBOX file expected: ${path}`);

    const raw = await readFile(path, 'utf-8');
    return this.ingestText(raw);
  }

  ingestText(raw) {
    const rawMessages = this.#splitMbox(raw);
    const parsed = rawMessages.map(m => this.#parseMessage(m)).filter(Boolean);

    // Group by thread (use threadId or subject-based grouping)
    const threads = new Map();
    for (const msg of parsed) {
      const key = msg.threadId || this.#normalizeSubject(msg.subject);
      if (!threads.has(key)) threads.set(key, []);
      threads.get(key).push(msg);
    }

    // Filter: only keep threads where I sent at least one message
    const myThreads = new Map();
    for (const [key, msgs] of threads) {
      const iSent = msgs.some(m => this.#isMe(m.fromEmail));
      if (iSent || this.myEmails.size === 0) {
        myThreads.set(key, msgs);
      }
    }

    // Build output
    const messages = [];
    const peopleMap = new Map();
    const channelMap = new Map();

    for (const [threadSubject, threadMsgs] of myThreads) {
      // Use normalized subject as "channel"
      const channelName = this.#normalizeSubject(threadSubject).slice(0, 80) || 'untitled';

      if (!channelMap.has(channelName)) {
        const participants = new Set();
        for (const m of threadMsgs) {
          participants.add(m.from);
          for (const r of m.to) participants.add(r);
        }
        channelMap.set(channelName, {
          name: channelName,
          type: participants.size <= 2 ? 'dm' : 'group',
        });
      }

      for (const msg of threadMsgs) {
        if (!peopleMap.has(msg.from)) {
          peopleMap.set(msg.from, { name: msg.from, aliases: [msg.fromEmail] });
        }
        for (const r of msg.to) {
          if (!peopleMap.has(r)) peopleMap.set(r, { name: r, aliases: [] });
        }

        messages.push({
          sender: msg.from,
          text: msg.body,
          timestamp: msg.date,
          channel: channelName,
          threadId: msg.threadId || undefined,
        });
      }
    }

    return {
      messages,
      channels: [...channelMap.values()],
      people: [...peopleMap.values()],
    };
  }

  // Split raw mbox text into individual message strings
  #splitMbox(raw) {
    const messages = [];
    // MBOX format: each message starts with "From " at the beginning of a line
    const parts = raw.split(/^From /m);
    for (let i = 1; i < parts.length; i++) {
      messages.push(parts[i]);
    }
    return messages;
  }

  // Parse a single raw email message
  #parseMessage(raw) {
    // Split headers from body
    const headerEnd = raw.search(/\r?\n\r?\n/);
    if (headerEnd === -1) return null;

    const headerBlock = raw.slice(0, headerEnd);
    let body = raw.slice(headerEnd).trim();

    const headers = this.#parseHeaders(headerBlock);

    const from = headers['from'] || '';
    const to = headers['to'] || '';
    const subject = headers['subject'] || '';
    const dateStr = headers['date'] || '';
    const messageId = headers['message-id'] || '';
    const inReplyTo = headers['in-reply-to'] || '';
    const references = headers['references'] || '';

    // Parse date
    let date;
    try {
      date = new Date(dateStr).getTime();
      if (isNaN(date)) date = 0;
    } catch { date = 0; }

    // Parse from name/email
    const { name: fromName, email: fromEmail } = this.#parseAddress(from);
    const toAddresses = this.#parseAddressList(to);

    // Build thread ID from references chain or in-reply-to
    const refIds = (references + ' ' + inReplyTo).trim().match(/<[^>]+>/g) || [];
    const threadId = refIds.length > 0 ? refIds[0] : messageId;

    // Clean body — strip quoted replies, HTML, signatures
    body = this.#cleanBody(body, headers['content-type'] || '');

    if (!body.trim() && !subject.trim()) return null;

    return {
      from: fromName || fromEmail,
      fromEmail: fromEmail.toLowerCase(),
      to: toAddresses.map(a => a.name || a.email),
      subject,
      body: body || `[${subject}]`,
      date,
      threadId,
      messageId,
    };
  }

  // Parse raw header block into key-value map (handles continuation lines)
  #parseHeaders(block) {
    const headers = {};
    let currentKey = '';
    let currentValue = '';

    for (const line of block.split(/\r?\n/)) {
      if (/^\s/.test(line)) {
        // Continuation of previous header
        currentValue += ' ' + line.trim();
      } else {
        if (currentKey) headers[currentKey] = currentValue;
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        currentKey = line.slice(0, colon).toLowerCase().trim();
        currentValue = line.slice(colon + 1).trim();
      }
    }
    if (currentKey) headers[currentKey] = currentValue;

    // Decode RFC 2047 encoded words (=?UTF-8?B?...?= or =?UTF-8?Q?...?=)
    for (const key of Object.keys(headers)) {
      headers[key] = this.#decodeRFC2047(headers[key]);
    }

    return headers;
  }

  #decodeRFC2047(str) {
    return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
      try {
        if (encoding.toUpperCase() === 'B') {
          return Buffer.from(text, 'base64').toString('utf-8');
        } else {
          // Q encoding
          return text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) =>
            String.fromCharCode(parseInt(hex, 16))
          );
        }
      } catch { return text; }
    });
  }

  // Parse "Name <email>" or just "email"
  #parseAddress(str) {
    const match = str.match(/^"?([^"<]*)"?\s*<([^>]+)>/);
    if (match) return { name: match[1].trim(), email: match[2].trim() };
    const emailOnly = str.match(/[\w.-]+@[\w.-]+/);
    return { name: '', email: emailOnly ? emailOnly[0] : str.trim() };
  }

  // Parse comma-separated address list
  #parseAddressList(str) {
    // Split on commas but not within quoted strings or angle brackets
    const addresses = [];
    let depth = 0;
    let current = '';
    for (const ch of str) {
      if (ch === '<') depth++;
      else if (ch === '>') depth--;
      else if (ch === ',' && depth === 0) {
        if (current.trim()) addresses.push(this.#parseAddress(current.trim()));
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) addresses.push(this.#parseAddress(current.trim()));
    return addresses;
  }

  // Clean email body — remove HTML, quoted text, signatures
  #cleanBody(body, contentType) {
    // Handle multipart — extract text/plain part
    if (contentType.includes('multipart')) {
      const boundary = contentType.match(/boundary="?([^";\s]+)"?/)?.[1];
      if (boundary) {
        const parts = body.split('--' + boundary);
        for (const part of parts) {
          if (part.includes('text/plain')) {
            const partBody = part.split(/\r?\n\r?\n/).slice(1).join('\n\n');
            return this.#cleanPlainText(partBody);
          }
        }
        // Fallback: try text/html
        for (const part of parts) {
          if (part.includes('text/html')) {
            const partBody = part.split(/\r?\n\r?\n/).slice(1).join('\n\n');
            return this.#stripHtml(partBody);
          }
        }
      }
    }

    if (contentType.includes('text/html')) {
      return this.#stripHtml(body);
    }

    // Handle base64 encoded text/plain
    if (contentType.includes('base64')) {
      try {
        body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
      } catch {}
    }

    // Handle quoted-printable
    if (contentType.includes('quoted-printable')) {
      body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }

    return this.#cleanPlainText(body);
  }

  #stripHtml(html) {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  #cleanPlainText(text) {
    const lines = text.split('\n');
    const cleaned = [];
    let hitSignature = false;

    for (const line of lines) {
      // Stop at signature markers
      if (/^--\s*$/.test(line) || /^_{3,}$/.test(line) || /^-{3,}$/.test(line)) {
        hitSignature = true;
      }
      // Stop at quoted text markers
      if (/^On .+ wrote:$/.test(line) || /^>/.test(line)) break;
      // Skip forwarded headers
      if (/^-+ Forwarded message -+$/.test(line)) break;
      if (/^From:/.test(line) && cleaned.length > 2) break;

      if (!hitSignature) cleaned.push(line);
    }

    return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  #normalizeSubject(subject) {
    // Strip Re:, Fwd:, etc
    return subject.replace(/^(re|fwd?|fw):\s*/gi, '').trim().toLowerCase();
  }

  #isMe(email) {
    return this.myEmails.has(email.toLowerCase());
  }
}
