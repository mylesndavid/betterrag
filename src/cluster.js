// Conversation clustering by time gaps + threads

const GAP_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Cluster messages into conversations.
 * Messages must have: { sender, text, timestamp, channel, threadId? }
 * Returns array of clusters: { id, channel, startTime, endTime, participants, messageCount, messages }
 */
export function clusterMessages(messages) {
  // Group by channel
  const byChannel = new Map();
  for (const msg of messages) {
    const ch = msg.channel || 'unknown';
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch).push(msg);
  }

  const clusters = [];
  let clusterId = 0;

  for (const [channel, channelMsgs] of byChannel) {
    // Separate threaded vs non-threaded messages
    const threads = new Map();
    const mainTimeline = [];

    for (const msg of channelMsgs) {
      if (msg.threadId) {
        if (!threads.has(msg.threadId)) threads.set(msg.threadId, []);
        threads.get(msg.threadId).push(msg);
      } else {
        mainTimeline.push(msg);
      }
    }

    // Cluster main timeline by time gaps
    mainTimeline.sort((a, b) => a.timestamp - b.timestamp);
    clusters.push(...clusterByGap(mainTimeline, channel, () => `cluster_${clusterId++}`));

    // Each thread becomes its own cluster
    for (const [threadId, threadMsgs] of threads) {
      threadMsgs.sort((a, b) => a.timestamp - b.timestamp);
      const participants = new Set(threadMsgs.map(m => m.sender));
      clusters.push({
        id: `cluster_${clusterId++}`,
        channel,
        threadId,
        startTime: threadMsgs[0].timestamp,
        endTime: threadMsgs[threadMsgs.length - 1].timestamp,
        participants: [...participants],
        participantCount: participants.size,
        messageCount: threadMsgs.length,
        messages: threadMsgs,
      });
    }
  }

  clusters.sort((a, b) => a.startTime - b.startTime);
  return clusters;
}

function clusterByGap(sortedMsgs, channel, nextId) {
  if (sortedMsgs.length === 0) return [];

  const clusters = [];
  let current = [sortedMsgs[0]];

  for (let i = 1; i < sortedMsgs.length; i++) {
    const gap = sortedMsgs[i].timestamp - sortedMsgs[i - 1].timestamp;
    if (gap > GAP_MS) {
      clusters.push(buildCluster(current, channel, nextId()));
      current = [sortedMsgs[i]];
    } else {
      current.push(sortedMsgs[i]);
    }
  }
  if (current.length > 0) {
    clusters.push(buildCluster(current, channel, nextId()));
  }
  return clusters;
}

function buildCluster(messages, channel, id) {
  const participants = new Set(messages.map(m => m.sender));
  return {
    id,
    channel,
    startTime: messages[0].timestamp,
    endTime: messages[messages.length - 1].timestamp,
    participants: [...participants],
    participantCount: participants.size,
    messageCount: messages.length,
    messages,
  };
}
