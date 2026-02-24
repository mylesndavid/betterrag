// Slack JSON export parser
// Slack exports: directory with channels.json, users.json, and per-channel dirs with date JSON files

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { BaseIngestor } from './base.js';

export class SlackIngestor extends BaseIngestor {
  canHandle(path) {
    // Slack exports are directories
    return true; // checked via stat in ingest
  }

  async ingest(path) {
    const pathStat = await stat(path);
    if (!pathStat.isDirectory()) {
      throw new Error(`Slack export path must be a directory: ${path}`);
    }

    // Load users map
    const users = await this.#loadUsers(path);
    // Load channels metadata
    const channelsMeta = await this.#loadChannels(path);

    const messages = [];
    const channels = [];
    const peopleMap = new Map();

    // Each subdirectory is a channel
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const channelName = entry.name;
      const channelDir = join(path, channelName);
      const meta = channelsMeta.get(channelName);
      channels.push({
        name: channelName,
        type: meta?.is_mpim ? 'group' : meta?.is_im ? 'dm' : 'channel',
      });

      // Read all JSON files in channel dir (one per day)
      const files = await readdir(channelDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const raw = await readFile(join(channelDir, file), 'utf-8');
        let dayMessages;
        try {
          dayMessages = JSON.parse(raw);
        } catch {
          continue;
        }

        for (const msg of dayMessages) {
          if (msg.subtype && msg.subtype !== 'thread_broadcast') continue; // skip system messages

          const sender = this.#resolveSender(msg, users);
          if (!peopleMap.has(sender)) {
            peopleMap.set(sender, { name: sender, aliases: [] });
          }

          const ts = parseFloat(msg.ts) * 1000;
          messages.push({
            sender,
            text: this.#cleanText(msg.text || '', users),
            timestamp: ts,
            channel: channelName,
            threadId: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
          });
        }
      }
    }

    return {
      messages,
      channels,
      people: [...peopleMap.values()],
    };
  }

  async #loadUsers(path) {
    const map = new Map();
    try {
      const raw = await readFile(join(path, 'users.json'), 'utf-8');
      const users = JSON.parse(raw);
      for (const u of users) {
        map.set(u.id, {
          name: u.profile?.display_name || u.profile?.real_name || u.name || u.id,
          realName: u.profile?.real_name,
        });
      }
    } catch {
      // No users.json — will use IDs as names
    }
    return map;
  }

  async #loadChannels(path) {
    const map = new Map();
    for (const file of ['channels.json', 'groups.json', 'mpims.json', 'dms.json']) {
      try {
        const raw = await readFile(join(path, file), 'utf-8');
        const channels = JSON.parse(raw);
        for (const ch of channels) {
          map.set(ch.name || ch.id, ch);
        }
      } catch {
        // file may not exist
      }
    }
    return map;
  }

  #resolveSender(msg, users) {
    const userId = msg.user || msg.bot_id;
    if (!userId) return 'unknown';
    const user = users.get(userId);
    return user?.name || userId;
  }

  #cleanText(text, users) {
    // Replace <@U1234> with display names
    return text.replace(/<@(U[A-Z0-9]+)>/g, (_, id) => {
      const user = users.get(id);
      return `@${user?.name || id}`;
    });
  }
}
