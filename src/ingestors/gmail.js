// Gmail IMAP ingestor — connects directly via app password
// Only indexes threads where the user has sent at least one message.

import { connect as tlsConnect } from 'node:tls';
import { BaseIngestor } from './base.js';

// Non-human senders to filter out
const BOT_SENDERS = new Set([
  'mail delivery subsystem', 'mailer-daemon', 'postmaster',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'accounts payable', 'relay test', 'auto responder',
]);
const BOT_DOMAINS = new Set([
  'linkedin.com', 'facebookmail.com', 'twitter.com', 'x.com',
  'pandadoc.com', 'pandadoc.net', 'docusign.com', 'docusign.net', 'calendly.com', 'zoom.us',
  'slack.com', 'notion.so', 'asana.com', 'trello.com',
  'github.com', 'gitlab.com', 'bitbucket.org',
  'stripe.com', 'paypal.com', 'square.com',
  'mailchimp.com', 'sendgrid.net', 'hubspot.com', 'intercom.io',
  'united.com', 'delta.com', 'aa.com', 'southwest.com',
  'uber.com', 'lyft.com', 'doordash.com', 'grubhub.com',
  'amazon.com', 'apple.com', 'google.com', 'netflix.com', 'spotify.com',
  'insider.group', 'substack.com', 'medium.com', 'beehiiv.com',
]);
const BOT_PATTERNS = [
  /newsletter/i, /notifications?@/i, /updates?@/i, /info@/i, /support@/i,
  /billing@/i, /receipts?@/i, /orders?@/i, /shipping@/i, /team@/i,
  /hello@.*\.(io|com|co|ai)$/i, /auto[-_]?respond/i,
  /^paradigm\s+auto/i, /accounts?\s+payable/i, /relay\s+test/i,
  /pandadoc/i, /docusign/i, /^zara\s+whitfield/i,
];

function isBot(email, name) {
  if (!email && !name) return false;
  const e = (email || '').toLowerCase();
  const n = (name || '').toLowerCase();
  // Exact match on name or email local part
  if (BOT_SENDERS.has(n) || BOT_SENDERS.has(e.split('@')[0])) return true;
  // Partial match — any bot sender phrase contained in the name
  for (const bot of BOT_SENDERS) {
    if (n.includes(bot)) return true;
  }
  const domain = e.split('@')[1] || '';
  if (BOT_DOMAINS.has(domain)) return true;
  for (const pat of BOT_PATTERNS) {
    if (pat.test(e) || pat.test(n)) return true;
  }
  return false;
}

export class GmailIngestor extends BaseIngestor {
  constructor(email, appPassword) {
    super();
    this.email = email;
    this.appPassword = appPassword;
    this.conn = null;
    this.tag = 0;
  }

  canHandle() { return true; }

  async ingest(path, opts = {}) {
    const folder = path || '[Gmail]/All Mail';
    const limit = opts.limit || 500;
    const sinceDate = opts.since || this.#monthsAgo(3);

    console.log(`Connecting to Gmail as ${this.email}...`);
    await this.#connect();
    await this.#login();

    console.log(`Selecting folder: ${folder}`);
    await this.#select(folder);

    // Search for messages I sent
    console.log(`Searching for sent messages since ${sinceDate}...`);
    const sentUids = await this.#search(`SINCE ${sinceDate} FROM "${this.email}"`);
    console.log(`Found ${sentUids.length} sent messages`);

    if (sentUids.length === 0) {
      await this.#logout();
      return { messages: [], channels: [], people: [] };
    }

    // Get headers for sent messages to find thread roots
    const limitedSentUids = sentUids.slice(-limit);
    console.log(`Fetching headers for ${limitedSentUids.length} sent messages...`);
    const sentMsgs = await this.#fetchBatch(limitedSentUids);

    // Collect thread roots from References headers
    const threadRoots = new Set();
    for (const m of sentMsgs) {
      const refs = this.#extractRefs(m.headers);
      threadRoots.add(refs.length > 0 ? refs[0] : m.headers['message-id'] || m.uid);
    }

    // Find all messages in those threads
    console.log(`Finding thread members for ${threadRoots.size} threads...`);
    const allUids = new Set(limitedSentUids);
    for (const root of threadRoots) {
      const clean = root.replace(/[<>]/g, '');
      if (!clean) continue;
      try {
        const related = await this.#search(`HEADER References "${clean}"`);
        for (const uid of related) allUids.add(uid);
      } catch {}
      try {
        const related = await this.#search(`HEADER Message-ID "${clean}"`);
        for (const uid of related) allUids.add(uid);
      } catch {}
    }

    // Fetch all messages with bodies
    const newUids = [...allUids].filter(u => !limitedSentUids.includes(u));
    console.log(`Fetching ${newUids.length} additional thread messages...`);
    const threadMsgs = newUids.length > 0 ? await this.#fetchBatch(newUids) : [];
    const allMessages = [...sentMsgs, ...threadMsgs];

    await this.#logout();

    return this.#buildOutput(allMessages);
  }

  // Fetch a batch of UIDs — gets headers + text body for each
  async #fetchBatch(uids) {
    const results = [];
    const batchSize = 25;
    for (let i = 0; i < uids.length; i += batchSize) {
      const batch = uids.slice(i, i + batchSize);
      for (const uid of batch) {
        try {
          const msg = await this.#fetchOne(uid);
          if (msg) results.push(msg);
        } catch (e) {
          // Skip individual message failures
        }
      }
      if (uids.length > batchSize) {
        console.log(`  ${Math.min(i + batchSize, uids.length)}/${uids.length} messages...`);
      }
    }
    return results;
  }

  // Fetch one message: envelope headers + best text body
  async #fetchOne(uid) {
    // Step 1: Get headers
    const headerResp = await this.#command(
      `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)] BODYSTRUCTURE)`
    );

    const headers = this.#parseHeaders(headerResp);
    if (!headers['from'] && !headers['subject']) return null;

    // Step 2: Figure out which MIME part has the text, and its encoding
    const { section, encoding } = this.#findTextPart(headerResp);

    // Step 3: Fetch that specific part
    let body = '';
    try {
      const bodyResp = await this.#command(`UID FETCH ${uid} (BODY.PEEK[${section}])`);
      body = this.#extractLiteral(bodyResp);

      // Decode transfer encoding
      if (encoding === 'BASE64' && body) {
        try { body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch {}
      } else if (encoding === 'QUOTED-PRINTABLE' && body) {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
          String.fromCharCode(parseInt(hex, 16)));
      } else if (!encoding || encoding === '7BIT' || encoding === '8BIT') {
        // plain text, no decoding needed
      } else if (body) {
        // Unknown encoding — try base64 if it looks like it
        if (/^[A-Za-z0-9+/=\s]+$/.test(body.trim())) {
          try { body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch {}
        }
      }

      body = this.#cleanBody(body);
    } catch {}

    const { name: fromName, email: fromEmail } = this.#parseAddress(headers['from'] || '');
    let date = 0;
    try { date = new Date(headers['date']).getTime(); } catch {}
    if (isNaN(date)) date = 0;

    // Parse To and Cc recipients
    const toRecipients = this.#parseAddressList(headers['to'] || '');
    const ccRecipients = this.#parseAddressList(headers['cc'] || '');

    return {
      uid,
      headers,
      fromName,
      fromEmail,
      toRecipients,
      ccRecipients,
      subject: headers['subject'] || '',
      date,
      body,
      messageId: headers['message-id'] || '',
    };
  }

  // Find the best text part from BODYSTRUCTURE
  // Returns { section, encoding } e.g. { section: "1.1", encoding: "base64" }
  #findTextPart(fetchResp) {
    // Check if it's a simple text/plain message (no multipart)
    if (/BODYSTRUCTURE \("TEXT" "PLAIN"/i.test(fetchResp)) {
      const enc = this.#extractPartEncoding(fetchResp, /BODYSTRUCTURE \("TEXT" "PLAIN" /i);
      return { section: '1', encoding: enc };
    }

    // Parse BODYSTRUCTURE to find text/plain in multipart
    // Walk through finding ("TEXT" "PLAIN" ...) patterns and track nesting
    const bsMatch = fetchResp.match(/BODYSTRUCTURE (\([\s\S]+\))\s*\)/i);
    if (!bsMatch) return { section: '1', encoding: null };

    const struct = bsMatch[1];
    return this.#walkBodyStructure(struct) || { section: '1', encoding: null };
  }

  // Recursively walk BODYSTRUCTURE to find text/plain part
  #walkBodyStructure(struct, prefix = '') {
    // Simple part: ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "BASE64" 1234)
    const simpleMatch = struct.match(/^\("TEXT"\s+"PLAIN"\s+/i);
    if (simpleMatch) {
      const enc = this.#extractEncodingFromPart(struct);
      return { section: prefix || '1', encoding: enc };
    }

    // Multipart: (part1)(part2)... "ALTERNATIVE" or "MIXED"
    // Find sub-parts by matching balanced parens at depth 1
    const parts = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < struct.length; i++) {
      if (struct[i] === '(') {
        if (depth === 0) start = i;
        depth++;
      } else if (struct[i] === ')') {
        depth--;
        if (depth === 0 && start >= 0) {
          parts.push(struct.slice(start, i + 1));
          start = -1;
        }
      }
    }

    // Each sub-part gets numbered 1, 2, 3...
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Skip if this looks like it's the multipart type string (not a real part)
      if (!/^\(/.test(part)) continue;

      const partNum = prefix ? `${prefix}.${i + 1}` : String(i + 1);

      // Check if this part is text/plain
      if (/^\("TEXT"\s+"PLAIN"/i.test(part)) {
        const enc = this.#extractEncodingFromPart(part);
        return { section: partNum, encoding: enc };
      }

      // Check if this is a nested multipart (starts with another paren group)
      if (/^\(\(/.test(part)) {
        const inner = part.slice(1, -1); // unwrap outer parens
        const result = this.#walkBodyStructure(inner, prefix ? `${prefix}.${i + 1}` : String(i + 1));
        if (result) return result;
      }
    }

    return null;
  }

  // Extract encoding (7BIT, BASE64, QUOTED-PRINTABLE) from a simple BODYSTRUCTURE part
  #extractEncodingFromPart(partStr) {
    // Format: ("TEXT" "PLAIN" (params) NIL NIL "ENCODING" size)
    // The encoding is the 6th field in the part tuple
    const tokens = [];
    let i = 1; // skip opening paren
    while (i < partStr.length && tokens.length < 7) {
      if (partStr[i] === '"') {
        const end = partStr.indexOf('"', i + 1);
        tokens.push(partStr.slice(i + 1, end));
        i = end + 1;
      } else if (partStr[i] === '(') {
        // Skip params block
        let d = 1;
        i++;
        while (i < partStr.length && d > 0) {
          if (partStr[i] === '(') d++;
          else if (partStr[i] === ')') d--;
          i++;
        }
        tokens.push('(params)');
      } else if (partStr.slice(i, i + 3).toUpperCase() === 'NIL') {
        tokens.push('NIL');
        i += 3;
      } else {
        i++;
      }
    }
    // tokens[0]=TEXT, [1]=PLAIN, [2]=params, [3]=NIL, [4]=NIL, [5]=encoding
    return tokens[5]?.toUpperCase() || null;
  }

  #extractPartEncoding(resp, pattern) {
    const m = resp.match(pattern);
    if (!m) return null;
    const after = resp.slice(m.index + m[0].length);
    if (/"base64"/i.test(after.slice(0, 200))) return 'BASE64';
    if (/"quoted-printable"/i.test(after.slice(0, 200))) return 'QUOTED-PRINTABLE';
    return null;
  }

  // Extract the literal content {N}\r\n...N bytes... from an IMAP response
  #extractLiteral(resp) {
    const match = resp.match(/\{(\d+)\}\r?\n/);
    if (!match) return '';
    const len = parseInt(match[1]);
    const start = match.index + match[0].length;
    return resp.slice(start, start + len);
  }

  // Parse headers from a FETCH response containing HEADER.FIELDS
  #parseHeaders(resp) {
    const headers = {};
    // Extract the literal block after HEADER.FIELDS
    const literal = this.#extractLiteral(resp);
    if (!literal) return headers;

    let currentKey = '';
    let currentValue = '';
    for (const line of literal.split(/\r?\n/)) {
      if (/^\s/.test(line) && currentKey) {
        currentValue += ' ' + line.trim();
      } else {
        if (currentKey) headers[currentKey] = this.#decodeRFC2047(currentValue);
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        currentKey = line.slice(0, colon).toLowerCase().trim();
        currentValue = line.slice(colon + 1).trim();
      }
    }
    if (currentKey) headers[currentKey] = this.#decodeRFC2047(currentValue);
    return headers;
  }

  #cleanBody(body) {
    if (!body) return '';

    // Detect undecoded base64 (long strings of alphanumeric with no spaces)
    {
      const rawLines = body.split('\n');
      const base64Lines = rawLines.filter(l => /^[A-Za-z0-9+/=]{40,}$/.test(l.trim()));
      if (base64Lines.length > rawLines.length * 0.3 && base64Lines.length > 3) {
        try {
          const decoded = Buffer.from(rawLines.join('').replace(/\s/g, ''), 'base64').toString('utf-8');
          if (decoded && !/[\x00-\x08\x0e-\x1f]/.test(decoded.slice(0, 200))) {
            body = decoded;
          } else {
            return '';
          }
        } catch {
          return '';
        }
      }
    }

    // Detect MIME boundaries that leaked through
    if (/^--[a-zA-Z0-9_=-]{20,}/m.test(body) && body.includes('Content-Type:')) {
      return '';
    }

    // Strip HTML if present
    if (/<[a-z][\s\S]*>/i.test(body)) {
      body = body
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\bquot\b/g, '');
    }

    // Strip quoted replies and signatures
    const lines = body.split('\n');
    const cleaned = [];
    for (const line of lines) {
      // Stop at reply markers
      if (/^On .+ wrote:\s*$/.test(line)) break;
      if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(line)) break;
      if (/^From:.*@/i.test(line) && cleaned.length > 3) break;
      // Skip quoted lines
      if (/^>/.test(line)) continue;
      // Stop at signature
      if (/^--\s*$/.test(line)) break;
      cleaned.push(line);
    }

    return cleaned.join('\n')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '')
      .slice(0, 5000);
  }

  #buildOutput(allMessages) {
    // Detect repeated signature by finding common suffix across my sent messages
    const myMessages = allMessages.filter(m => m?.fromEmail?.toLowerCase() === this.email.toLowerCase() && m.body);
    const sigText = this.#detectSignature(myMessages);
    if (sigText) {
      this.signatureLines = new Set(sigText.split('\n').map(l => this.#normSigLine(l)).filter(l => l.length > 2));
      console.log(`Detected signature (${this.signatureLines.size} lines), stripping from messages`);
    } else {
      this.signatureLines = null;
    }

    const messages = [];
    const peopleMap = new Map();
    const channelMap = new Map();

    // Group by thread
    const threads = new Map();
    for (const msg of allMessages) {
      if (!msg) continue;
      const refs = this.#extractRefs(msg.headers);
      const threadKey = refs.length > 0 ? refs[0] : msg.messageId || msg.uid;
      if (!threads.has(threadKey)) threads.set(threadKey, []);
      threads.get(threadKey).push(msg);
    }

    // Only keep threads where I sent at least one message
    for (const [threadKey, threadMsgs] of threads) {
      const iSent = threadMsgs.some(m =>
        m.fromEmail?.toLowerCase() === this.email.toLowerCase()
      );
      if (!iSent) continue;

      threadMsgs.sort((a, b) => a.date - b.date);

      const subject = threadMsgs.find(m => m.subject)?.subject || 'untitled';
      const channelName = subject.replace(/^(re|fwd?|fw):\s*/gi, '').trim().slice(0, 80) || 'untitled';

      // Skip automated/transactional threads
      if (/^(appointment|booking|confirmation|receipt|invoice|order|shipping|delivery|your .* (order|booking|receipt|confirmation|password|account))/i.test(channelName)) continue;
      if (/^(action required|verify your|reset your|welcome to|invitation:)/i.test(channelName)) continue;

      // Skip threads where ALL participants (except bots) are filtered out
      const realParticipants = threadMsgs.filter(m => !isBot(m.fromEmail, m.fromName) && m.fromName !== 'unknown');
      if (realParticipants.length === 0) continue;

      // Collect ALL participants: senders + To + Cc recipients
      const allParticipants = new Set();
      for (const m of threadMsgs) {
        if (m.fromName || m.fromEmail) allParticipants.add(m.fromName || m.fromEmail);
        for (const r of [...(m.toRecipients || []), ...(m.ccRecipients || [])]) {
          if (!isBot(r.email, r.name)) {
            const rName = r.name || r.email;
            allParticipants.add(rName);
            // Add recipients as people
            if (!peopleMap.has(rName)) {
              peopleMap.set(rName, { name: rName, aliases: r.email ? [r.email] : [] });
            }
          }
        }
      }

      if (!channelMap.has(channelName)) {
        channelMap.set(channelName, {
          name: channelName,
          type: allParticipants.size <= 2 ? 'dm' : 'group',
        });
      }

      for (const msg of threadMsgs) {
        const sender = msg.fromName || msg.fromEmail || 'unknown';
        if (sender === 'unknown') continue;
        if (isBot(msg.fromEmail, msg.fromName)) continue;
        if (!peopleMap.has(sender)) {
          peopleMap.set(sender, { name: sender, aliases: msg.fromEmail ? [msg.fromEmail] : [] });
        }

        let body = msg.body || `[${msg.subject || 'no subject'}]`;
        if (this.signatureLines) body = this.#stripSignature(body);
        if (!body.trim()) continue;

        messages.push({
          sender,
          text: body,
          timestamp: msg.date,
          channel: channelName,
          threadId: threadKey,
        });

        // Add lightweight "participated" entries for To/Cc recipients
        // so they get SENT_IN edges to clusters they were part of
        const seen = new Set([sender]);
        for (const r of [...(msg.toRecipients || []), ...(msg.ccRecipients || [])]) {
          if (isBot(r.email, r.name)) continue;
          const rName = r.name || r.email;
          if (seen.has(rName)) continue;
          seen.add(rName);
          // Skip self
          if (r.email?.toLowerCase() === this.email.toLowerCase()) continue;
          messages.push({
            sender: rName,
            text: '',  // empty — just for graph edges, not cluster content
            timestamp: msg.date,
            channel: channelName,
            threadId: threadKey,
            _participantOnly: true,  // flag so clustering can skip for text
          });
        }
      }
    }

    // Deduplicate people: merge entries that share the same email address
    // Prefer display name over raw email as the canonical name
    const dedupedPeople = this.#deduplicatePeople(peopleMap);

    // Remap sender names in messages to canonical names
    for (const msg of messages) {
      if (dedupedPeople.remap.has(msg.sender)) {
        msg.sender = dedupedPeople.remap.get(msg.sender);
      }
    }

    return {
      messages,
      channels: [...channelMap.values()],
      people: dedupedPeople.list,
    };
  }

  // Detect repeated signature by finding common trailing lines across sent messages
  #detectSignature(myMessages) {
    if (myMessages.length < 3) return null;

    // Get the last N lines of each message (normalized)
    const tails = myMessages
      .map(m => {
        const lines = m.body.trim().split('\n')
          .map(l => this.#normSigLine(l))
          .filter(l => l.length > 0);
        return lines.slice(-20);
      })
      .filter(t => t.length > 2);

    if (tails.length < 3) return null;

    // Find common suffix LINES — compare normalized lines from the bottom up
    // Start with the first tail, intersect with each subsequent one
    let commonLines = tails[0].slice();
    for (let i = 1; i < Math.min(tails.length, 30); i++) {
      commonLines = this.#commonSuffixLines(commonLines, tails[i]);
      if (commonLines.length < 1) break;
    }

    if (commonLines.length < 1) {
      // Fallback: frequency-based detection
      // If certain lines appear in 60%+ of messages, they're signature
      return this.#frequencySignature(tails);
    }

    const sig = commonLines.join('\n').trim();
    return sig.length >= 15 ? sig : this.#frequencySignature(tails);
  }

  #commonSuffixLines(a, b) {
    const result = [];
    let ai = a.length - 1;
    let bi = b.length - 1;
    while (ai >= 0 && bi >= 0) {
      if (a[ai].toLowerCase() === b[bi].toLowerCase()) {
        result.unshift(a[ai]);
        ai--; bi--;
      } else {
        break;
      }
    }
    return result;
  }

  // Fallback: find lines that appear in 35%+ of sent messages — they're signature
  #frequencySignature(tails) {
    const lineCount = new Map();
    for (const tail of tails) {
      const seen = new Set();
      for (const line of tail) {
        const norm = this.#normSigLine(line);
        if (norm.length < 3 || seen.has(norm)) continue;
        seen.add(norm);
        lineCount.set(norm, (lineCount.get(norm) || 0) + 1);
      }
    }

    const threshold = Math.max(tails.length * 0.35, 3);
    const sigLines = [];
    for (const [line, count] of lineCount) {
      if (count >= threshold) {
        sigLines.push(line);
      }
    }

    return sigLines.length >= 1 ? sigLines.join('\n') : null;
  }

  // Deduplicate people: merge "myles@devvcore.com" and "Myles David" into one
  #deduplicatePeople(peopleMap) {
    // Build email → best name mapping
    const emailToName = new Map(); // email → display name
    const nameToEmails = new Map(); // name → Set of emails

    for (const [name, person] of peopleMap) {
      for (const alias of (person.aliases || [])) {
        const email = alias.toLowerCase();
        if (!emailToName.has(email)) {
          emailToName.set(email, name);
        } else {
          // Prefer the version with a proper display name (not an email address)
          const existing = emailToName.get(email);
          if (existing.includes('@') && !name.includes('@')) {
            emailToName.set(email, name);
          }
        }
      }
    }

    // Also build a name-part index for fuzzy matching
    // "myles" should match "Myles David", "Manueld1" won't match "Manuel David"
    const nameIndex = new Map(); // lowercase first name → full display name
    for (const [name] of peopleMap) {
      if (name.includes('@')) continue; // skip email-only entries
      const parts = name.toLowerCase().split(/\s+/);
      for (const part of parts) {
        if (part.length > 2 && !nameIndex.has(part)) {
          nameIndex.set(part, name);
        }
      }
    }

    // Now build canonical name for each person entry
    const remap = new Map(); // old name → canonical name
    const canonical = new Map(); // canonical name → merged person

    for (const [name, person] of peopleMap) {
      let bestName = name;

      // If this name IS an email, see if we have a display name for it
      if (name.includes('@')) {
        const mapped = emailToName.get(name.toLowerCase());
        if (mapped && mapped !== name) bestName = mapped;
        // Also try matching the local part to a known person
        if (bestName.includes('@')) {
          const local = name.split('@')[0].toLowerCase();
          const nameMatch = nameIndex.get(local);
          if (nameMatch) bestName = nameMatch;
        }
      }

      // If this is a short name (single word, no email), try matching to a full name
      if (!name.includes('@') && !name.includes(' ')) {
        const nameMatch = nameIndex.get(name.toLowerCase());
        if (nameMatch && nameMatch !== name) bestName = nameMatch;
      }

      // Check if any alias maps to a better name
      for (const alias of (person.aliases || [])) {
        const mapped = emailToName.get(alias.toLowerCase());
        if (mapped && !mapped.includes('@') && bestName.includes('@')) {
          bestName = mapped;
        }
      }

      if (bestName !== name) remap.set(name, bestName);

      if (!canonical.has(bestName)) {
        canonical.set(bestName, { name: bestName, aliases: new Set() });
      }
      const c = canonical.get(bestName);
      for (const a of (person.aliases || [])) c.aliases.add(a.toLowerCase());
      if (name.includes('@')) c.aliases.add(name.toLowerCase());
    }

    const list = [...canonical.values()].map(p => ({
      // Clean up display names: strip "(email@domain)" suffix
      name: p.name.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim() || p.name,
      aliases: [...p.aliases],
    }));

    return { list, remap };
  }

  // Strip detected signature lines from a message body
  #stripSignature(body) {
    if (!this.signatureLines || this.signatureLines.size === 0) return body;
    const lines = body.split('\n');
    const cleaned = [];
    for (const line of lines) {
      const norm = this.#normSigLine(line);
      if (norm.length < 2) { cleaned.push(line); continue; }
      if (this.signatureLines.has(norm)) continue;
      cleaned.push(line);
    }
    return cleaned.join('\n').trim();
  }

  // Normalize a line for signature comparison — strip formatting, punctuation, whitespace
  #normSigLine(line) {
    return line
      .toLowerCase()
      .replace(/[*_~`#>|]/g, '') // strip markdown formatting
      .replace(/[^\w\s@.-]/g, ' ') // strip special chars except email-relevant ones
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---- IMAP protocol ----

  async #connect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
      this.conn = tlsConnect({ host: 'imap.gmail.com', port: 993, servername: 'imap.gmail.com' });
      this.conn.setEncoding('utf-8');
      this.conn.on('error', (e) => { clearTimeout(timeout); reject(e); });
      this.conn.once('data', (data) => {
        clearTimeout(timeout);
        if (data.includes('* OK')) resolve();
        else reject(new Error('Bad IMAP greeting: ' + data.slice(0, 100)));
      });
    });
  }

  async #command(cmd) {
    const tag = `A${++this.tag}`;
    return new Promise((resolve, reject) => {
      let response = '';
      const timeout = setTimeout(() => {
        this.conn.removeListener('data', onData);
        reject(new Error(`IMAP timeout: ${cmd.slice(0, 50)}`));
      }, 30000);
      const onData = (chunk) => {
        response += chunk;
        // Look for tagged completion at start of line
        const lines = response.split('\r\n');
        for (const line of lines) {
          if (line.startsWith(`${tag} OK`) || line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
            clearTimeout(timeout);
            this.conn.removeListener('data', onData);
            if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
              reject(new Error(`IMAP: ${line}`));
            } else {
              resolve(response);
            }
            return;
          }
        }
      };
      this.conn.on('data', onData);
      this.conn.write(`${tag} ${cmd}\r\n`);
    });
  }

  async #login() { await this.#command(`LOGIN "${this.email}" "${this.appPassword}"`); }
  async #select(folder) { await this.#command(`SELECT "${folder}"`); }

  async #search(criteria) {
    const resp = await this.#command(`UID SEARCH ${criteria}`);
    const match = resp.match(/\* SEARCH ([\d\s]+)/);
    if (!match) return [];
    return match[1].trim().split(/\s+/).filter(Boolean);
  }

  #extractRefs(headers) {
    const refs = ((headers['references'] || '') + ' ' + (headers['in-reply-to'] || '')).trim();
    return refs.match(/<[^>]+>/g) || [];
  }

  // Parse comma-separated address list (To, Cc headers)
  #parseAddressList(str) {
    if (!str) return [];
    // Split on commas that aren't inside quotes or angle brackets
    const results = [];
    let current = '';
    let inQuote = false;
    let inAngle = false;
    for (const ch of str) {
      if (ch === '"') inQuote = !inQuote;
      else if (ch === '<') inAngle = true;
      else if (ch === '>') inAngle = false;
      else if (ch === ',' && !inQuote && !inAngle) {
        const parsed = this.#parseAddress(current.trim());
        if (parsed.email) results.push(parsed);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) {
      const parsed = this.#parseAddress(current.trim());
      if (parsed.email) results.push(parsed);
    }
    return results;
  }

  #parseAddress(str) {
    if (!str) return { name: '', email: '' };
    const match = str.match(/"?([^"<]*)"?\s*<([^>]+)>/);
    if (match) {
      let name = match[1].trim();
      // Strip email-in-parens from display name: "Bronsexual (bronsexual@aimakesai.ai)" → "Bronsexual"
      name = name.replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim();
      return { name, email: match[2].trim() };
    }
    const emailOnly = str.match(/[\w.+-]+@[\w.-]+/);
    return { name: '', email: emailOnly ? emailOnly[0] : str.trim() };
  }

  #decodeRFC2047(str) {
    if (!str) return '';
    return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, enc, text) => {
      try {
        if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf-8');
        return text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
      } catch { return text; }
    });
  }

  async #logout() {
    try { await this.#command('LOGOUT'); } catch {}
    try { this.conn.destroy(); } catch {}
  }

  #monthsAgo(n) {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
  }
}
