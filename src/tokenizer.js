// Tokenize messages, extract entities, stopword removal, TF-IDF

const STOPWORDS = new Set([
  // Standard English
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
  'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
  'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
  'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above',
  'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's',
  't', 'can', 'will', 'just', 'don', 'should', 'now', 'd', 'll', 'm', 'o', 're',
  've', 'y', 'ain', 'aren', 'couldn', 'didn', 'doesn', 'hadn', 'hasn', 'haven',
  'isn', 'ma', 'mightn', 'mustn', 'needn', 'shan', 'shouldn', 'wasn', 'weren',
  'won', 'wouldn', 'also', 'could', 'would', 'like', 'get', 'got', 'going',
  'go', 'know', 'think', 'thing', 'things', 'really', 'yeah', 'yes', 'no', 'ok',
  'okay', 'well', 'right', 'good', 'one', 'two', 'much', 'way', 'even', 'still',
  'let', 'maybe', 'sure', 'actually', 'though', 'pretty', 'basically', 'literally',
  'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'lol', 'haha', 'hah', 'lmao',
  'omg', 'oh', 'ah', 'um', 'uh', 'hmm', 'hey', 'hi', 'hello', 'thanks', 'thank',
  'please', 'sorry', 'great', 'awesome', 'cool', 'nice', 'ha', 'gonna', 'make',
  'made', 'want', 'need', 'take', 'say', 'said', 'see', 'look', 'come', 'came',
  'back', 'use', 'used', 'try', 'put', 'give', 'new', 'something', 'anything',
  'everything', 'nothing', 'someone', 'anyone', 'everyone', 'people', 'time',
  'day', 'work', 'bit', 'lot', 'kind', 'part', 'point', 'feel', 'mean', 'tell',
  // Chat-specific filler
  'join', 'joined', 'working', 'today', 'call', 'guys', 'message', 'add', 'added',
  'using', 'check', 'send', 'sent', 'done', 'already', 'update', 'able', 'yet',
  'morning', 'afternoon', 'tonight', 'tomorrow', 'yesterday', 'week', 'pls',
  'asap', 'fyi', 'btw', 'etc', 'gonna', 'didn', 'doesn', 'isn', 'wasn',
  'link', 'click', 'open', 'close', 'delete', 'deleted', 'share', 'shared',
  'image', 'omitted', 'media', 'video', 'audio', 'document', 'sticker', 'gif',
  'attached', 'photo', 'file', 'sent', 'any', 'lads', 'needs', 'i\'ll', 'i\'m',
  'i\'ve', 'i\'d', 'it\'s', 'that\'s', 'there\'s', 'what\'s', 'don\'t', 'won\'t',
  'can\'t', 'didn\'t', 'doesn\'t', 'wasn\'t', 'couldn\'t', 'wouldn\'t', 'shouldn\'t',
  'haven\'t', 'hasn\'t', 'isn\'t', 'aren\'t', 'weren\'t', 'let\'s', 'he\'s', 'she\'s',
  'we\'re', 'they\'re', 'you\'re', 'we\'ve', 'they\'ve', 'you\'ve', 'who\'s',
  'here\'s', 'sounds', 'sounds', 'meeting', 'gonna', 'alright', 'fine', 'yep',
  'nah', 'nope', 'yea', 'bruh', 'bro', 'dude', 'man', 'sir', 'miss',
  // Common URL fragments that leak through
  'com', 'org', 'net', 'www', 'http', 'https', 'html', 'htm',
  // Email-specific filler
  'best', 'regards', 'kind', 'cheers', 'sincerely', 'warm', 'warmly',
  'phone', 'email', 'website', 'mobile', 'office', 'cell', 'fax',
  'sent', 'iphone', 'android', 'outlook', 'gmail', 'mail',
  'confidential', 'disclaimer', 'intended', 'recipient', 'privileged',
  'unsubscribe', 'subscribe', 'preferences', 'opt-out', 'optout',
  'view', 'browser', 'forward', 'reply', 'respond', 'response',
  'wrote', 'original', 'subject', 'date', 'thread',
  'dear', 'hello', 'hope', 'well', 'reach', 'reaching', 'touch',
  'base', 'quick', 'follow', 'following', 'attached', 'attachment',
  'per', 'happy', 'discuss', 'discussed', 'conversation', 'chat',
  'free', 'feel', 'hesitate', 'questions', 'question',
  'appreciate', 'appreciated', 'advance', 'forward',
  'address', 'name', 'company', 'title', 'position',
  'founder', 'ceo', 'cto', 'coo', 'director', 'manager', 'head',
  'linkedin', 'twitter', 'facebook', 'instagram',
  // Phone number fragments
  'tel', 'ext',
  // HTML entity remnants
  'quot', 'amp', 'nbsp', 'lt', 'gt', 'apos',
  // Generic verbs/nouns that aren't meaningful as entities
  'find', 'found', 'list', 'possible', 'key', 'set', 'start', 'started',
  'end', 'ended', 'run', 'running', 'help', 'create', 'created',
  'change', 'changed', 'move', 'moved', 'keep', 'fix', 'fixed',
  'issue', 'issues', 'problem', 'setup', 'next', 'last', 'first',
  'number', 'page', 'line', 'thing', 'stuff', 'lot', 'bit',
  'build', 'built', 'scale', 'scaling', 'kill', 'killing',
  'unfair', 'advantages', 'inefficiencies', 'ruthlessly',
  'works', 'working', 'getting', 'wanted', 'saw', 'hours', 'minutes',
  'team', 'teams', 'update', 'updates', 'updated', 'status',
  'section', 'sections', 'notice', 'missing', 'review', 'reviewed',
  'processing', 'process',
  'receive', 'received', 'show', 'showing', 'include', 'includes',
  'require', 'required', 'requires', 'need', 'needed',
  'provide', 'provided', 'available', 'complete', 'completed',
  'currently', 'current', 'looking', 'getting', 'taking',
  'specific', 'different', 'additional', 'important',
  'into', 'mine', 'yours', 'along', 'within', 'without', 'across',
  'since', 'already', 'never', 'always', 'also', 'still',
  'save', 'saved', 'valid', 'optimal', 'test', 'tested',
  'thu', 'tue', 'wed', 'mon', 'fri', 'sat', 'sun',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

// Noise patterns — entire tokens to reject
const NOISE_RE = /^(image|media|video|audio|document|sticker|gif|omitted|deleted|attached|null|undefined|nan|true|false|\d+)$/;
const PHONE_RE = /^[\d\s+\-().]{7,}$/;
const PHONE_FRAG_RE = /^-?\d{3,}$/;  // catches "-1372" type fragments
const HEX_RE = /^[0-9a-f]{8,}$/;     // hex hashes
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}t?\d{0,2}/i; // ISO timestamps

const URL_RE = /https?:\/\/[^\s<>]+/g;
const MENTION_RE = /@[\w.-]+/g;
const CHANNEL_RE = /#[\w.-]+/g;
// Match email addresses to strip them from tokenization
const EMAIL_RE = /[\w.-]+@[\w.-]+\.\w+/g;

/**
 * Extract special entities (URLs, @mentions, #channels) from text
 */
export function extractSpecialEntities(text) {
  const entities = [];
  for (const m of text.matchAll(URL_RE)) entities.push({ type: 'url', value: m[0] });
  for (const m of text.matchAll(MENTION_RE)) entities.push({ type: 'mention', value: m[0].slice(1).toLowerCase() });
  for (const m of text.matchAll(CHANNEL_RE)) entities.push({ type: 'channel', value: m[0].slice(1).toLowerCase() });
  return entities;
}

/**
 * Tokenize text into lowercase words, removing stopwords and short tokens
 */
export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, '')   // strip URLs
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, '') // strip emails
    .replace(/\[media\]/g, '')            // strip [media] placeholders
    .replace(/<media omitted>/gi, '')     // strip media omitted
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && w.length < 40 && !STOPWORDS.has(w) && !NOISE_RE.test(w) && !PHONE_RE.test(w) && !PHONE_FRAG_RE.test(w) && !HEX_RE.test(w) && !TIMESTAMP_RE.test(w) && !/^[0-9a-f]{1,2}[a-z]/.test(w));
}

/**
 * Count term frequencies from an array of tokens
 */
export function termFrequency(tokens) {
  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
  return freq;
}

/**
 * Find significant bigrams from tokens (pairs appearing 2+ times)
 */
export function extractBigrams(tokens, minCount = 2) {
  const counts = new Map();
  for (let i = 0; i < tokens.length - 1; i++) {
    const pair = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  const bigrams = new Map();
  for (const [pair, count] of counts) {
    if (count >= minCount) bigrams.set(pair, count);
  }
  return bigrams;
}

/**
 * Normalize a term — merge plurals and reversed bigrams to a canonical form.
 * Uses the existing merged map to check for reversed bigrams.
 */
function normalizeTerm(name, existing) {
  // Reversed bigram: if "manual procedure" exists and we see "procedure manual", merge
  const parts = name.split(' ');
  if (parts.length === 2) {
    const reversed = parts[1] + ' ' + parts[0];
    if (existing.has(reversed)) return reversed;
  }

  // Depluralize: "systems" → "system", "leads" → "lead"
  // But preserve words where the base form is different (e.g., "process" vs "processes")
  if (name.endsWith('es') && name.length > 4) {
    const base = name.slice(0, -2);
    if (existing.has(base)) return base;
    // tries → try (ies → y)
  }
  if (name.endsWith('ies') && name.length > 4) {
    const base = name.slice(0, -3) + 'y';
    if (existing.has(base)) return base;
  }
  if (name.endsWith('s') && !name.endsWith('ss') && name.length > 3) {
    const base = name.slice(0, -1);
    if (existing.has(base)) return base;
  }

  return name;
}

/**
 * Extract entities from a set of messages (cluster).
 * personNames: Set of lowercase person names to filter out (optional)
 * Returns array of { name, frequency, type } sorted by frequency desc.
 */
export function extractEntities(messages, personNames) {
  const allTokens = [];
  const specialEntities = new Map();

  for (const msg of messages) {
    const text = msg.text || '';
    allTokens.push(...tokenize(text));

    for (const ent of extractSpecialEntities(text)) {
      const key = `${ent.type}:${ent.value}`;
      const existing = specialEntities.get(key);
      if (existing) existing.frequency++;
      else specialEntities.set(key, { name: ent.value, type: ent.type, frequency: 1 });
    }
  }

  const freq = termFrequency(allTokens);
  const bigrams = extractBigrams(allTokens);

  // Merge bigrams — if a bigram is significant, boost it and reduce component words
  for (const [bigram, count] of bigrams) {
    const [a, b] = bigram.split(' ');
    freq.set(bigram, count);
    // Reduce unigrams that are part of frequent bigrams
    if (freq.has(a)) freq.set(a, Math.max(0, freq.get(a) - count));
    if (freq.has(b)) freq.set(b, Math.max(0, freq.get(b) - count));
  }

  // Build person name tokens for filtering (first name, last name, full name)
  // Also strips emoji/unicode so "Manuel😎" matches "manuel"
  const nameTokens = new Set();
  if (personNames) {
    for (const name of personNames) {
      const clean = name.replace(/[^a-z0-9\s'-]/g, '').trim();
      nameTokens.add(clean);
      nameTokens.add(name);
      for (const part of clean.split(/\s+/)) {
        if (part.length > 2) nameTokens.add(part);
      }
    }
  }

  // Normalize: merge plurals (system/systems → system) and reversed bigrams
  const merged = new Map();
  for (const [name, frequency] of freq) {
    if (frequency <= 0) continue;
    if (nameTokens.has(name)) continue;
    if (/^\w+\.\w+(\.\w+)?$/.test(name) && /\.(com|org|net|io|ai|co|dev|app)$/.test(name)) continue;

    const canonical = normalizeTerm(name, merged);
    if (merged.has(canonical)) {
      merged.get(canonical).frequency += frequency;
    } else {
      merged.set(canonical, { name: canonical, frequency, type: 'term' });
    }
  }

  const entities = [...merged.values()];
  for (const ent of specialEntities.values()) {
    entities.push(ent);
  }

  entities.sort((a, b) => b.frequency - a.frequency);
  return entities;
}

/**
 * Compute TF-IDF scores for entities across multiple clusters.
 * clusterEntities: array of entity arrays (one per cluster)
 * Returns Map of entity name → idf weight
 */
export function computeIDF(clusterEntities) {
  const docCount = clusterEntities.length;
  const docFreq = new Map();

  for (const entities of clusterEntities) {
    const seen = new Set(entities.map(e => e.name));
    for (const name of seen) {
      docFreq.set(name, (docFreq.get(name) || 0) + 1);
    }
  }

  const idf = new Map();
  for (const [name, df] of docFreq) {
    idf.set(name, Math.log(docCount / df));
  }
  return idf;
}

/**
 * Score entities in a cluster using TF-IDF
 */
export function scoreTFIDF(entities, idf) {
  return entities.map(e => ({
    ...e,
    tfidf: e.frequency * (idf.get(e.name) || 1),
  })).sort((a, b) => b.tfidf - a.tfidf);
}
