/**
 * Tests for query classifier
 */
import { describe, it, expect } from 'vitest';
import {
  classifyQuery,
  getSearchWeights,
  tokenizeQuery,
  expandQuery,
  processQuery,
  buildEnhancedFTSQuery,
  SYNONYM_MAP,
  type QueryType
} from '../src/query-classifier.js';

describe('Query Classifier', () => {
  describe('classifyQuery', () => {
    it('classifies symbol queries', () => {
      expect(classifyQuery('fetchUserData')).toBe('symbol');
      expect(classifyQuery('APIClient.get')).toBe('symbol');
      expect(classifyQuery('handleSubmit')).toBe('symbol');
      expect(classifyQuery('User.findById')).toBe('symbol');
    });

    it('classifies concept queries', () => {
      expect(classifyQuery('how do I implement authentication')).toBe('concept');
      expect(classifyQuery('where is the database configuration')).toBe('concept');
      expect(classifyQuery('what is the best way to handle errors')).toBe('concept');
      expect(classifyQuery('show me all api endpoints')).toBe('concept');
    });

    it('classifies pattern queries', () => {
      expect(classifyQuery('react hook pattern')).toBe('pattern');
      expect(classifyQuery('error handling middleware')).toBe('pattern');
      expect(classifyQuery('database connection pool')).toBe('pattern');
    });

    it('handles edge cases', () => {
      expect(classifyQuery('')).toBe('pattern');
      expect(classifyQuery('a')).toBe('pattern');
    });
  });

  describe('getSearchWeights', () => {
    it('returns correct weights for symbol queries', () => {
      const weights = getSearchWeights('symbol');
      expect(weights.bm25).toBe(0.60);
      expect(weights.vector).toBe(0.40);
      expect(weights.rerank).toBe(0.30);
    });

    it('returns correct weights for concept queries', () => {
      const weights = getSearchWeights('concept');
      expect(weights.bm25).toBe(0.15);
      expect(weights.vector).toBe(0.85);
      expect(weights.rerank).toBe(0.50);
    });

    it('returns correct weights for pattern queries', () => {
      const weights = getSearchWeights('pattern');
      expect(weights.bm25).toBe(0.30);
      expect(weights.vector).toBe(0.70);
      expect(weights.rerank).toBe(0.40);
    });
  });

  describe('tokenizeQuery', () => {
    it('keeps short queries intact', () => {
      expect(tokenizeQuery('how do I')).toBe('how do I');
      expect(tokenizeQuery('fetch data')).toBe('fetch data');
    });

    it('removes filler words from long queries', () => {
      // 'how' is a question word that should be preserved
      expect(tokenizeQuery('how do I implement the authentication')).toBe('how implement authentication');
      expect(tokenizeQuery('what is the best way to handle errors')).toBe('what best way handle errors');
    });

    it('preserves code tokens', () => {
      expect(tokenizeQuery('how do I use the fetchUserData function')).toBe('how use fetchUserData function');
      expect(tokenizeQuery('what is the best APIClient.config setup')).toBe('what best APIClient.config setup');
    });
  });

  describe('expandQuery', () => {
    it('expands auth-related queries', () => {
      const expansions = expandQuery('how to implement login');
      expect(expansions).toContain('auth');
      expect(expansions).toContain('authentication');
      expect(expansions).toContain('token');
      expect(expansions).toContain('jwt');
    });

    it('expands database-related queries', () => {
      const expansions = expandQuery('database schema design');
      expect(expansions).toContain('db');
      expect(expansions).toContain('sql');
      expect(expansions).toContain('migration');
    });

    it('returns empty for non-matching queries', () => {
      expect(expandQuery('xyz abc')).toEqual([]);
    });

    it('limits to 15 expansions', () => {
      // Auth has many synonyms
      const expansions = expandQuery('authentication');
      expect(expansions.length).toBeLessThanOrEqual(15);
    });
  });

  describe('processQuery', () => {
    it('processes symbol queries correctly', () => {
      const result = processQuery('fetchUserData');
      expect(result.queryType).toBe('symbol');
      expect(result.bm25Weight).toBe(0.60);
      expect(result.vectorWeight).toBe(0.40);
      expect(result.expandedTerms).toEqual([]); // No expansion for symbols
    });

    it('processes concept queries correctly', () => {
      const result = processQuery('how do I implement authentication');
      expect(result.queryType).toBe('concept');
      expect(result.bm25Weight).toBe(0.15);
      expect(result.vectorWeight).toBe(0.85);
      expect(result.expandedTerms.length).toBeGreaterThan(0);
    });

    it('handles empty queries', () => {
      const result = processQuery('');
      expect(result.queryType).toBe('pattern');
      expect(result.tokenizedQuery).toBe('');
    });
  });

  describe('buildEnhancedFTSQuery', () => {
    it('returns base query without expansions', () => {
      const processed = processQuery('fetchUserData');
      expect(buildEnhancedFTSQuery(processed)).toBe('fetchUserData');
    });

    it('combines base with expanded terms', () => {
      const processed = processQuery('how to implement login');
      const ftsQuery = buildEnhancedFTSQuery(processed);
      expect(ftsQuery).toContain('implement login');
      expect(ftsQuery).toContain('OR');
    });
  });

  describe('SYNONYM_MAP coverage', () => {
    it('has expected concept categories', () => {
      expect(SYNONYM_MAP.auth).toBeDefined();
      expect(SYNONYM_MAP.database).toBeDefined();
      expect(SYNONYM_MAP.api).toBeDefined();
      expect(SYNONYM_MAP.ui).toBeDefined();
      expect(SYNONYM_MAP.error).toBeDefined();
      expect(SYNONYM_MAP.test).toBeDefined();
      expect(SYNONYM_MAP.async).toBeDefined();
      expect(SYNONYM_MAP.git).toBeDefined();
    });
  });
});
