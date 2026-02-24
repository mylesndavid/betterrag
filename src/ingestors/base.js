// Base ingestor interface — normalize to common message format

/**
 * Common message format:
 * {
 *   sender: string,       // display name or username
 *   text: string,         // message body
 *   timestamp: number,    // Unix ms
 *   channel: string,      // channel/chat name
 *   threadId?: string,    // thread ID if threaded
 * }
 */

export class BaseIngestor {
  /**
   * @param {string} path — path to export file or directory
   * @returns {{ messages: Array, channels: Array<{name, type}>, people: Array<{name, aliases}> }}
   */
  async ingest(path) {
    throw new Error('ingest() must be implemented by subclass');
  }

  /**
   * Detect if this ingestor can handle the given path
   * @param {string} path
   * @returns {boolean}
   */
  canHandle(path) {
    throw new Error('canHandle() must be implemented by subclass');
  }
}
