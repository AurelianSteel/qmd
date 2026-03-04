/**
 * Query Classifier - Intelligent query classification for search optimization
 * 
 * Classifies queries into types and applies optimal search strategies:
 * - Symbol queries (function/class names) → keyword-weighted
 * - Concept queries (natural language) → semantic-weighted
 * - Pattern queries (code patterns) → balanced
 */

export type QueryType = 'symbol' | 'concept' | 'pattern';

export interface SearchWeights {
  /** Weight for BM25/FTS search (0-1) */
  bm25: number;
  /** Weight for vector/semantic search (0-1) */
  vector: number;
  /** Weight for reranker influence (0-1) */
  rerank: number;
}

export interface ProcessedQuery {
  /** Original query string */
  originalQuery: string;
  /** Cleaned query for embedding */
  tokenizedQuery: string;
  /** Expanded terms for keyword search */
  expandedTerms: string[];
  /** Classified query type */
  queryType: QueryType;
  /** Optimal BM25 weight for this query type */
  bm25Weight: number;
  /** Optimal vector weight for this query type */
  vectorWeight: number;
  /** Optimal reranker weight for this query type */
  rerankWeight: number;
}

/**
 * Synonym map for programming concept expansion.
 * Maps concept keywords to related terms for improved keyword search.
 */
export const SYNONYM_MAP: Record<string, string[]> = {
  // Authentication & Security
  auth: ['auth', 'authentication', 'login', 'signin', 'signout', 'logout', 'session', 'credential', 'token', 'jwt', 'oauth', 'password', 'authorize'],
  
  // Database
  database: ['database', 'db', 'sql', 'query', 'migration', 'schema', 'table', 'column', 'record', 'model', 'orm', 'entity'],
  
  // API & HTTP
  api: ['api', 'endpoint', 'route', 'handler', 'request', 'response', 'rest', 'controller', 'middleware', 'router'],
  
  // UI & Frontend
  ui: ['ui', 'view', 'component', 'layout', 'render', 'display', 'screen', 'widget', 'interface', 'frontend'],
  
  // Error Handling
  error: ['error', 'exception', 'throw', 'catch', 'fail', 'crash', 'bug', 'issue', 'panic', 'recover'],
  
  // Testing
  test: ['test', 'spec', 'assert', 'expect', 'mock', 'stub', 'fixture', 'unittest', 'e2e', 'integration'],
  
  // Network & HTTP
  network: ['network', 'http', 'fetch', 'request', 'url', 'socket', 'websocket', 'connection', 'client', 'server'],
  
  // Storage & Caching
  storage: ['storage', 'cache', 'persist', 'save', 'store', 'disk', 'file', 'write', 'read', 'localstorage'],
  
  // Configuration
  config: ['config', 'configuration', 'settings', 'preferences', 'options', 'environment', 'env', 'dotenv'],
  
  // Navigation
  nav: ['navigation', 'navigate', 'route', 'router', 'redirect', 'link', 'path', 'url', 'goto'],
  
  // State Management
  state: ['state', 'store', 'redux', 'context', 'provider', 'observable', 'published', 'binding', 'signal'],
  
  // Styling
  style: ['style', 'css', 'theme', 'color', 'font', 'margin', 'padding', 'layout', 'design', 'tailwind'],
  
  // Async & Concurrency
  async: ['async', 'await', 'promise', 'future', 'concurrent', 'parallel', 'dispatch', 'queue', 'thread', 'worker'],
  
  // Parsing & Serialization
  parse: ['parse', 'decode', 'deserialize', 'json', 'xml', 'serialize', 'encode', 'format', 'stringify'],
  
  // Validation
  validate: ['validate', 'validation', 'check', 'verify', 'sanitize', 'constraint', 'rule', 'schema'],
  
  // Security
  security: ['security', 'encrypt', 'decrypt', 'hash', 'salt', 'password', 'permission', 'authorize', 'xss', 'csrf'],
  
  // Deployment
  deploy: ['deploy', 'build', 'ci', 'cd', 'pipeline', 'release', 'publish', 'ship', 'vercel', 'docker'],
  
  // Version Control
  git: ['git', 'commit', 'branch', 'merge', 'rebase', 'push', 'pull', 'clone', 'diff', 'status', 'repository'],
  
  // Media
  image: ['image', 'photo', 'picture', 'thumbnail', 'avatar', 'icon', 'graphic', 'media', 'upload'],
  
  // Notifications
  notify: ['notification', 'notify', 'alert', 'push', 'email', 'sms', 'message', 'toast', 'banner'],
  
  // Search
  search: ['search', 'find', 'filter', 'query', 'lookup', 'index', 'match', 'fuzzy', 'fts'],
  
  // Logging
  log: ['log', 'logging', 'debug', 'trace', 'print', 'monitor', 'analytics', 'telemetry', 'sentry'],
  
  // Payments
  payment: ['payment', 'pay', 'charge', 'invoice', 'billing', 'subscription', 'stripe', 'checkout', 'cart'],
  
  // Users
  user: ['user', 'account', 'profile', 'member', 'role', 'permission', 'admin', 'customer'],
  
  // File Operations
  upload: ['upload', 'download', 'transfer', 'import', 'export', 'attach', 'file', 'blob', 'stream'],
  
  // Scheduling
  schedule: ['schedule', 'cron', 'timer', 'interval', 'recurring', 'background', 'job', 'task', 'queue', 'worker'],
  
  // ML/AI
  embed: ['embed', 'embedding', 'vector', 'similarity', 'semantic', 'cosine', 'llm', 'ai', 'model'],
  
  // Text Processing
  chunk: ['chunk', 'split', 'segment', 'tokenize', 'partition', 'slice', 'truncate'],
  
  // Browser/DOM
  browser: ['browser', 'webview', 'dom', 'document', 'window', 'element', 'selector', 'event'],
  
  // Process Management
  process: ['process', 'spawn', 'exec', 'shell', 'command', 'terminal', 'subprocess', 'child'],
};

/**
 * Filler words to strip from queries during tokenization
 */
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'from', 'by',
  'that', 'which', 'this', 'these', 'those', 'it', 'its',
  'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could',
  'will', 'would', 'should', 'may', 'might', 'must', 'shall',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'her', 'our', 'their',
  'am', 'being', 'having', 'do', 'does', 'did', 'done'
]);

/**
 * Question words that indicate concept queries
 */
const QUESTION_WORDS = ['how', 'where', 'what', 'why', 'when', 'which', 'find', 'show', 'list', 'get', 'explain', 'describe'];

/**
 * Characters that indicate code/symbol patterns
 */
const CODE_OPERATORS = ['.', '(', ')', '<', '>', '_', ':', '::', '->', '=>'];

/**
 * Classify a query to determine optimal search strategy
 */
export function classifyQuery(query: string): QueryType {
  const trimmed = query.trim();
  if (!trimmed) return 'pattern';

  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  
  // Single word or 2 words that look like code identifiers → symbol
  if (words.length <= 2) {
    const allCodeLike = words.every(w => isCodeToken(w));
    if (allCodeLike) return 'symbol';
  }

  // Contains code operators and short → symbol
  const hasCodeOps = CODE_OPERATORS.some(op => trimmed.includes(op));
  if (hasCodeOps && words.length <= 3) return 'symbol';

  // Question words at start → concept
  const firstWord = words[0]?.toLowerCase();
  if (firstWord && QUESTION_WORDS.includes(firstWord)) {
    return 'concept';
  }

  // Longer queries without code tokens → concept
  if (words.length >= 4 && !hasCodeOps) {
    return 'concept';
  }

  // Default: pattern (balanced)
  return 'pattern';
}

/**
 * Get optimal search weights for a query type
 */
export function getSearchWeights(type: QueryType): SearchWeights {
  switch (type) {
    case 'symbol':
      // Symbol queries: prioritize exact keyword matches
      return { bm25: 0.60, vector: 0.40, rerank: 0.30 };
    case 'concept':
      // Concept queries: prioritize semantic understanding
      return { bm25: 0.15, vector: 0.85, rerank: 0.50 };
    case 'pattern':
      // Pattern queries: balanced approach
      return { bm25: 0.30, vector: 0.70, rerank: 0.40 };
    default:
      return { bm25: 0.30, vector: 0.70, rerank: 0.40 };
  }
}

/**
 * Question words to preserve during tokenization
 */
const PRESERVE_WORDS = new Set(['how', 'where', 'what', 'why', 'when', 'which', 'find', 'show', 'list', 'get']);

/**
 * Tokenize a query by removing filler words
 */
export function tokenizeQuery(query: string): string {
  const words = query.trim().split(/\s+/).filter(w => w.length > 0);
  
  // Keep short queries as-is
  if (words.length < 4) return query;

  const filtered = words.filter(word => {
    // Always keep code tokens
    if (isCodeToken(word)) return true;
    // Preserve question/action words
    if (PRESERVE_WORDS.has(word.toLowerCase())) return true;
    // Strip filler words
    return !FILLER_WORDS.has(word.toLowerCase());
  });

  // Don't strip everything - keep at least 2 words
  if (filtered.length < 2) return query;
  
  return filtered.join(' ');
}

/**
 * Expand a concept query with related terms from synonym map
 */
export function expandQuery(query: string): string[] {
  const lowered = query.toLowerCase();
  const expansions: string[] = [];

  for (const [_, terms] of Object.entries(SYNONYM_MAP)) {
    // Check if any term from this group appears in the query
    const matched = terms.some(t => lowered.includes(t));
    if (matched) {
      // Add all other terms from this group as expansions
      for (const term of terms) {
        if (!lowered.includes(term)) {
          expansions.push(term);
        }
      }
    }
  }

  // Limit to prevent query explosion
  return expansions.slice(0, 15);
}

/**
 * Check if a word looks like a code identifier
 */
function isCodeToken(word: string): boolean {
  // Contains dots, underscores, parens, colons, or angle brackets
  if (/[.()_<>:]/.test(word)) return true;
  
  // camelCase detection: lowercase letter followed by uppercase
  if (/[a-z][A-Z]/.test(word)) return true;
  
  // PascalCase detection: starts with uppercase, has lowercase after
  if (/^[A-Z][a-z]/.test(word) && /[A-Z]/.test(word.slice(1))) return true;
  
  // snake_case detection
  if (/_/.test(word) && /^[a-z_]/.test(word)) return true;
  
  return false;
}

/**
 * Process a query through the full pipeline
 */
export function processQuery(query: string): ProcessedQuery {
  const trimmed = query.trim();
  
  if (!trimmed) {
    return {
      originalQuery: query,
      tokenizedQuery: '',
      expandedTerms: [],
      queryType: 'pattern',
      bm25Weight: 0.30,
      vectorWeight: 0.70,
      rerankWeight: 0.40
    };
  }

  // Step 1: Classify
  const queryType = classifyQuery(trimmed);
  
  // Step 2: Tokenize
  const tokenizedQuery = tokenizeQuery(trimmed);
  
  // Step 3: Expand (only for concept queries)
  const expandedTerms = queryType === 'concept' ? expandQuery(trimmed) : [];
  
  // Step 4: Get weights
  const weights = getSearchWeights(queryType);

  return {
    originalQuery: query,
    tokenizedQuery,
    expandedTerms,
    queryType,
    bm25Weight: weights.bm25,
    vectorWeight: weights.vector,
    rerankWeight: weights.rerank
  };
}

/**
 * Build an enhanced FTS5 query with expanded terms
 */
export function buildEnhancedFTSQuery(processed: ProcessedQuery): string {
  const baseTerms = processed.tokenizedQuery || processed.originalQuery;
  
  if (processed.expandedTerms.length === 0) {
    return baseTerms;
  }
  
  // Combine original with expanded terms using OR
  const allTerms = [baseTerms, ...processed.expandedTerms];
  return allTerms.join(' OR ');
}

/**
 * Get a human-readable description of the query classification
 */
export function getClassificationDescription(type: QueryType): string {
  switch (type) {
    case 'symbol':
      return 'symbol (prioritizing exact matches)';
    case 'concept':
      return 'concept (prioritizing semantic understanding)';
    case 'pattern':
      return 'pattern (balanced search)';
    default:
      return 'unknown';
  }
}
