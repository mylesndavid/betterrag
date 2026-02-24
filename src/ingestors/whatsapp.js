// WhatsApp .txt export parser
// Handles many real-world WhatsApp export formats:
//   "DD/MM/YYYY, HH:MM - Sender: Message"
//   "[M/D/YY, H:MM:SS AM] Sender: Message"
//   "DD/MM/YY, HH:MM - Sender: Message"
//   Unicode BOM, \r\n line endings, media omitted, system messages

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { BaseIngestor } from './base.js';

// Matches many WhatsApp timestamp+sender formats:
//   Android: "DD/MM/YYYY, HH:MM - Sender: text"
//   iOS:     "[DD/MM/YYYY, HH:MM:SS] Sender: text"
//   US:      "M/D/YY, H:MM AM - Sender: text"
const LINE_RE = /^\u200e?\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]?\s*(?:[-–—]\s*)?(.+?):\s(.*)$/;

// System line — no "sender: message" structure, just a notice after the timestamp
const SYSTEM_LINE_RE = /^\u200e?\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]?\s*(?:[-–—]\s*)?([^:]+)$/;

// System / non-human senders to skip
const SYSTEM_RE = /^(system|you (created|changed|added|removed|were|left|joined)|messages and calls|this message was deleted|waiting for this message|\+\d+ was (added|removed)|.+ changed the subject|.+ added .+|.+ removed .+|.+ left|.+ joined|your security code .+|.+ created group)/i;
const MEDIA_RE = /^(<Media omitted>|<attached: .+>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|GIF omitted|Contact card omitted)$/i;

export class WhatsAppIngestor extends BaseIngestor {
  canHandle(path) {
    return path.endsWith('.txt');
  }

  /**
   * Ingest from file path
   */
  async ingest(path) {
    const pathStat = await stat(path);
    if (!pathStat.isFile()) {
      throw new Error(`WhatsApp export must be a .txt file: ${path}`);
    }
    const raw = await readFile(path, 'utf-8');
    const channelName = basename(path, '.txt').replace(/WhatsApp Chat with /i, '').trim();
    return this.ingestText(raw, channelName);
  }

  /**
   * Ingest from raw text content (for upload UI)
   */
  ingestText(raw, channelName = 'chat') {
    // Strip BOM
    const cleaned = raw.replace(/^\uFEFF/, '');
    const lines = cleaned.split(/\r?\n/);

    const messages = [];
    const peopleMap = new Map();
    let currentMsg = null;

    for (const line of lines) {
      // Strip leading LTR/RTL marks
      const stripped = line.replace(/^[\u200E\u200F\u202A-\u202E]+/, '');

      // Skip system lines (timestamp + notice, no sender:message structure)
      if (SYSTEM_LINE_RE.test(stripped) && !LINE_RE.test(stripped)) continue;

      const match = stripped.match(LINE_RE);

      if (match) {
        if (currentMsg) messages.push(currentMsg);
        const [, date, time, sender, text] = match;

        // Skip system messages by sender name
        if (SYSTEM_RE.test(sender)) {
          currentMsg = null;
          continue;
        }

        const timestamp = this.#parseDate(date, time);
        if (isNaN(timestamp)) { currentMsg = null; continue; }

        if (!peopleMap.has(sender)) {
          peopleMap.set(sender, { name: sender, aliases: [] });
        }

        // Skip media-omitted but still count the message
        const msgText = MEDIA_RE.test(text.trim()) ? '[media]' : text;
        currentMsg = { sender, text: msgText, timestamp, channel: channelName };
      } else if (currentMsg && stripped.trim()) {
        // Continuation of previous message (multi-line)
        currentMsg.text += '\n' + stripped.trim();
      }
    }
    if (currentMsg) messages.push(currentMsg);

    const type = peopleMap.size <= 2 ? 'dm' : 'group';

    return {
      messages,
      channels: [{ name: channelName, type }],
      people: [...peopleMap.values()],
    };
  }

  #parseDate(dateStr, timeStr) {
    const parts = dateStr.split('/');
    let [d, m, y] = parts.map(Number);
    if (y < 100) y += 2000;

    // Build date — assume DD/MM/YYYY (most common WhatsApp locale)
    const dateObj = new Date(y, m - 1, d);

    // Parse time
    let timePart = timeStr.trim();
    const isPM = /pm/i.test(timePart);
    const isAM = /am/i.test(timePart);
    timePart = timePart.replace(/\s*[APap][Mm]/i, '');
    const [h, min, sec] = timePart.split(':').map(Number);
    let hours = h;
    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    dateObj.setHours(hours, min, sec || 0);
    return dateObj.getTime();
  }
}
