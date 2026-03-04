/**
 * Two-Phase Code Indexer
 * 
 * Phase 1: Fast FTS index (blocking) - search works immediately
 * Phase 2: Background embeddings (non-blocking) - semantic search enhancement
 * 
 * Based on CodeFire's indexing pattern:
 * - Content-hash skipping for unchanged files
 * - WAL mode for concurrent access
 * - Resumable embeddings
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import fg from 'fast-glob';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { Database } from '../db.js';

export interface CodeChunk {
  id: string;
  fileId: string;
  content: string;
  symbolName?: string;
  startLine: number;
  endLine: number;
  language: string;
  embedding?: Float32Array;
}

export interface IndexedFile {
  id: string;
  projectPath: string;
  relativePath: string;
  contentHash: string;
  language: string;
  indexedAt: Date;
  chunkCount: number;
}

export interface IndexProgress {
  phase: 'enumerating' | 'indexing' | 'embedding' | 'complete';
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  embeddedChunks: number;
  currentFile?: string;
}

export interface IndexOptions {
  projectPath: string;
  projectName: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  batchSize?: number;
  embeddingConcurrency?: number;
  onProgress?: (progress: IndexProgress) => void;
}

const DEFAULT_INCLUDE = [
  '**/*.{ts,tsx,js,jsx}',
  '**/*.{py,rs,go,java}',
  '**/*.swift',
  '**/*.{rb,php}',
  '**/*.md',
];

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/build/**',
  '**/dist/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/*.lock',
  '**/*.log',
  '**/*.min.js',
  '**/*.min.css',
];

export class TwoPhaseCodeIndexer extends EventEmitter {
  private db: Database;
  private options: IndexOptions;
  private isIndexing = false;
  private isEmbedding = false;
  private stopEmbedding = false;

  constructor(db: Database, options: IndexOptions) {
    super();
    this.db = db;
    this.options = {
      includePatterns: DEFAULT_INCLUDE,
      excludePatterns: DEFAULT_EXCLUDE,
      batchSize: 10,
      embeddingConcurrency: 5,
      ...options,
    };
    this.initSchema();
  }

  private initSchema(): void {
    // Enable WAL mode for concurrent access
    this.db.exec("PRAGMA journal_mode = WAL");

    // Files table with content hash for change detection
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_index_files (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        language TEXT,
        indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        chunk_count INTEGER DEFAULT 0,
        UNIQUE(project_name, relative_path)
      )
    `);

    // Chunks table - FTS5 for text search
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_index_chunks (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        content TEXT NOT NULL,
        symbol_name TEXT,
        start_line INTEGER,
        end_line INTEGER,
        language TEXT,
        embedding BLOB,
        FOREIGN KEY (file_id) REFERENCES code_index_files(id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_code_files_project ON code_index_files(project_name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_code_files_hash ON code_index_files(content_hash)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_index_chunks(file_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding ON code_index_chunks(embedding) WHERE embedding IS NOT NULL`);

    // FTS5 virtual table for fast text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS code_chunks_fts USING fts5(
        content,
        symbol_name,
        content='code_index_chunks',
        content_rowid='rowid'
      )
    `);

    // Triggers to keep FTS5 in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_ai AFTER INSERT ON code_index_chunks BEGIN
        INSERT INTO code_chunks_fts(rowid, content, symbol_name) 
        VALUES (new.rowid, new.content, new.symbol_name);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS code_chunks_ad AFTER DELETE ON code_index_chunks BEGIN
        INSERT INTO code_chunks_fts(code_chunks_fts, rowid, content, symbol_name) 
        VALUES ('delete', old.rowid, old.content, old.symbol_name);
      END
    `);

    // Index state tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_index_state (
        project_name TEXT PRIMARY KEY,
        status TEXT,
        total_files INTEGER DEFAULT 0,
        total_chunks INTEGER DEFAULT 0,
        embedded_chunks INTEGER DEFAULT 0,
        last_error TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /**
   * Phase 1: Fast FTS Index (Blocking)
   * Enumerates files, chunks code, stores in SQLite with FTS5
   */
  async phase1Index(): Promise<void> {
    if (this.isIndexing) {
      throw new Error('Indexing already in progress');
    }
    this.isIndexing = true;
    this.stopEmbedding = false;

    const { projectPath, projectName, onProgress } = this.options;
    
    this.updateState('indexing', { totalFiles: 0, totalChunks: 0 });
    this.emit('progress', { phase: 'enumerating', totalFiles: 0, processedFiles: 0, totalChunks: 0, embeddedChunks: 0 });

    try {
      // Enumerate files
      const files = await this.enumerateFiles(projectPath);
      const existingFiles = this.getExistingFiles(projectName);
      
      let processedFiles = 0;
      let totalChunks = 0;

      this.emit('progress', { 
        phase: 'indexing', 
        totalFiles: files.length, 
        processedFiles: 0, 
        totalChunks: 0, 
        embeddedChunks: 0 
      });

      for (const filePath of files) {
        if (this.stopEmbedding) break;

        const relativePath = path.relative(projectPath, filePath);
        const content = await readFile(filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');

        // Skip unchanged files
        const existing = existingFiles[relativePath];
        if (existing?.contentHash === hash) {
          processedFiles++;
          continue;
        }

        // Delete old chunks if file changed
        if (existing) {
          this.db.prepare('DELETE FROM code_index_chunks WHERE file_id = ?').run(existing.id);
        }

        // Parse and chunk the file
        const language = this.detectLanguage(filePath);
        const chunks = this.chunkFile(content, relativePath, language);
        const fileId = existing?.id || this.generateId();

        // Insert/update file record
        this.db.prepare(`
          INSERT OR REPLACE INTO code_index_files 
          (id, project_name, project_path, relative_path, content_hash, language, chunk_count, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(fileId, projectName, projectPath, relativePath, hash, language, chunks.length);

        // Insert chunks (without embeddings - Phase 2 will add them)
        const insertChunk = this.db.prepare(`
          INSERT INTO code_index_chunks (id, file_id, content, symbol_name, start_line, end_line, language)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const chunk of chunks) {
          insertChunk.run(
            this.generateId(),
            fileId,
            chunk.content,
            chunk.symbolName || null,
            chunk.startLine,
            chunk.endLine,
            chunk.language
          );
        }

        processedFiles++;
        totalChunks += chunks.length;

        this.emit('progress', { 
          phase: 'indexing', 
          totalFiles: files.length, 
          processedFiles, 
          totalChunks, 
          embeddedChunks: 0,
          currentFile: relativePath
        });

        if (onProgress) {
          onProgress({ 
            phase: 'indexing', 
            totalFiles: files.length, 
            processedFiles, 
            totalChunks, 
            embeddedChunks: 0 
          });
        }
      }

      // Cleanup orphaned files
      this.cleanupOrphanedFiles(projectName, projectPath);

      const finalStats = this.db.prepare(`
        SELECT COUNT(*) as total_chunks FROM code_index_chunks ch
        JOIN code_index_files f ON ch.file_id = f.id
        WHERE f.project_name = ?
      `).get(projectName) as { total_chunks: number };

      this.updateState('ready', { 
        totalFiles: processedFiles, 
        totalChunks: finalStats.total_chunks 
      });

      this.emit('phase1Complete', { files: processedFiles, chunks: finalStats.total_chunks });

    } catch (error) {
      this.updateState('error', { lastError: String(error) });
      throw error;
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Phase 2: Background Embedding (Non-blocking)
   * Generates embeddings for chunks that don't have them
   */
  async phase2Embed(ollamaUrl: string = 'http://localhost:11434'): Promise<void> {
    if (this.isEmbedding) {
      console.log('Embedding already in progress, resuming...');
      return;
    }
    this.isEmbedding = true;
    this.stopEmbedding = false;

    const { projectName, batchSize, embeddingConcurrency, onProgress } = this.options;

    try {
      while (!this.stopEmbedding) {
        // Get batch of unembedded chunks
        const chunks = this.db.prepare(`
          SELECT ch.id, ch.content, ch.symbol_name, ch.language, f.relative_path
          FROM code_index_chunks ch
          JOIN code_index_files f ON ch.file_id = f.id
          WHERE f.project_name = ? AND ch.embedding IS NULL
          LIMIT ?
        `).all(projectName, batchSize) as Array<{
          id: string;
          content: string;
          symbol_name: string;
          language: string;
          relative_path: string;
        }>;

        if (chunks.length === 0) break;

        // Generate embeddings via Ollama
        const texts = chunks.map(c => this.formatForEmbedding(c.content, c.symbol_name, c.language));
        const embeddings = await this.embedBatch(texts, ollamaUrl);

        // Store embeddings
        const update = this.db.prepare('UPDATE code_index_chunks SET embedding = ? WHERE id = ?');
        
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = embeddings[i];
          if (chunk && embedding) {
            const buffer = Buffer.from(embedding.buffer);
            update.run(buffer, chunk.id);
          }
        }

        // Update progress
        const stats = this.getStats(projectName);
        
        this.emit('progress', { 
          phase: 'embedding', 
          totalFiles: stats.totalFiles, 
          processedFiles: stats.totalFiles, 
          totalChunks: stats.totalChunks, 
          embeddedChunks: stats.embeddedChunks 
        });

        if (onProgress) {
          onProgress({ 
            phase: 'embedding', 
            totalFiles: stats.totalFiles, 
            processedFiles: stats.totalFiles, 
            totalChunks: stats.totalChunks, 
            embeddedChunks: stats.embeddedChunks 
          });
        }

        // Small delay to not overwhelm
        await new Promise(r => setTimeout(r, 100));
      }

      this.emit('phase2Complete');

    } finally {
      this.isEmbedding = false;
    }
  }

  /**
   * Search using available indices
   */
  search(query: string, options: {
    projectName: string;
    limit?: number;
    useSemantic?: boolean;
    ollamaUrl?: string;
  }): Array<{
    chunkId: string;
    filePath: string;
    content: string;
    symbolName?: string;
    startLine: number;
    endLine: number;
    score: number;
  }> {
    const { projectName, limit = 10, useSemantic = false } = options;

    // Escape special characters for FTS5 MATCH
    // Replace hyphens with spaces and wrap in quotes if needed
    const escapedQuery = query.replace(/-/g, ' ').replace(/"/g, '""');
    const ftsQuery = `"${escapedQuery}"`;

    // Always use FTS5 (fast, always available)
    const ftsResults = this.db.prepare(`
      SELECT 
        ch.id as chunk_id,
        ch.content,
        ch.symbol_name,
        ch.start_line,
        ch.end_line,
        f.relative_path as file_path,
        rank as fts_score
      FROM code_chunks_fts
      JOIN code_index_chunks ch ON code_chunks_fts.rowid = ch.rowid
      JOIN code_index_files f ON ch.file_id = f.id
      WHERE code_chunks_fts MATCH ? AND f.project_name = ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, projectName, limit) as Array<{
      chunk_id: string;
      content: string;
      symbol_name: string;
      start_line: number;
      end_line: number;
      file_path: string;
      fts_score: number;
    }>;

    // TODO: Add semantic search if useSemantic=true and embeddings available

    return ftsResults.map(r => ({
      chunkId: r.chunk_id,
      filePath: r.file_path,
      content: r.content,
      symbolName: r.symbol_name,
      startLine: r.start_line,
      endLine: r.end_line,
      score: r.fts_score,
    }));
  }

  /**
   * Check if semantic search is available (all chunks have embeddings)
   */
  hasEmbeddings(projectName: string): boolean {
    const result = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN ch.embedding IS NOT NULL THEN 1 ELSE 0 END) as embedded
      FROM code_index_chunks ch
      JOIN code_index_files f ON ch.file_id = f.id
      WHERE f.project_name = ?
    `).get(projectName) as { total: number; embedded: number } | undefined;

    return result ? result.total > 0 && result.embedded === result.total : false;
  }

  /**
   * Get indexing stats
   */
  getStats(projectName: string): {
    totalFiles: number;
    totalChunks: number;
    embeddedChunks: number;
    hasEmbeddings: boolean;
  } {
    const files = (this.db.prepare(`
      SELECT COUNT(*) as count FROM code_index_files WHERE project_name = ?
    `).get(projectName) as { count: number })?.count ?? 0;

    const chunks = (this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM code_index_chunks ch
      JOIN code_index_files f ON ch.file_id = f.id
      WHERE f.project_name = ?
    `).get(projectName) as { count: number })?.count ?? 0;

    const embedded = (this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM code_index_chunks ch
      JOIN code_index_files f ON ch.file_id = f.id
      WHERE f.project_name = ? AND ch.embedding IS NOT NULL
    `).get(projectName) as { count: number })?.count ?? 0;

    return {
      totalFiles: files,
      totalChunks: chunks,
      embeddedChunks: embedded,
      hasEmbeddings: chunks > 0 && embedded === chunks,
    };
  }

  /**
   * Stop background embedding
   */
  stop(): void {
    this.stopEmbedding = true;
  }

  private async enumerateFiles(projectPath: string): Promise<string[]> {
    const files = await fg(this.options.includePatterns!, {
      cwd: projectPath,
      ignore: this.options.excludePatterns,
      absolute: true,
    });
    return files;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.swift': 'swift',
      '.rb': 'ruby',
      '.php': 'php',
      '.md': 'markdown',
    };
    return langMap[ext] || 'unknown';
  }

  private chunkFile(content: string, filePath: string, language: string): CodeChunk[] {
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    const chunkSize = 50; // Lines per chunk

    // Simple line-based chunking for now
    // TODO: Use Tree-sitter for semantic chunking
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const chunkContent = chunkLines.join('\n');
      
      // Try to extract symbol name from first line
      const firstLine = chunkLines[0] || '';
      const symbolMatch = firstLine.match(/(?:export\s+)?(?:async\s+)?(?:function|class|interface|const|let|var)\s+(\w+)/);
      
      chunks.push({
        id: this.generateId(),
        fileId: '', // Will be set by caller
        content: chunkContent,
        symbolName: symbolMatch?.[1],
        startLine: i + 1,
        endLine: Math.min(i + chunkSize, lines.length),
        language,
      });
    }

    return chunks;
  }

  private formatForEmbedding(content: string, symbolName: string | null, language: string): string {
    let formatted = '';
    if (symbolName) {
      formatted += `${symbolName} `;
    }
    formatted += `(${language}): `;
    formatted += content.slice(0, 1000); // Truncate very long chunks
    return formatted;
  }

  private async embedBatch(texts: string[], ollamaUrl: string): Promise<Float32Array[]> {
    const model = 'nomic-embed-text'; // Default embedding model
    
    try {
      const response = await fetch(`${ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      return data.embeddings.map((e: number[]) => new Float32Array(e));
    } catch (error) {
      console.error('Embedding generation failed:', error);
      return texts.map(() => new Float32Array(768)); // Return zero vectors on error
    }
  }

  private getExistingFiles(projectName: string): Record<string, IndexedFile> {
    const rows = this.db.prepare(`
      SELECT * FROM code_index_files WHERE project_name = ?
    `).all(projectName) as IndexedFile[];
    
    return Object.fromEntries(rows.map(r => [r.relativePath, r]));
  }

  private cleanupOrphanedFiles(projectName: string, projectPath: string): void {
    const existingPaths = (this.db.prepare(`
      SELECT relative_path FROM code_index_files WHERE project_name = ?
    `).all(projectName) as Array<{ relative_path: string }>).map(r => r.relative_path);

    for (const relativePath of existingPaths) {
      const fullPath = path.join(projectPath, relativePath);
      if (!existsSync(fullPath)) {
        this.db.prepare('DELETE FROM code_index_files WHERE project_name = ? AND relative_path = ?')
          .run(projectName, relativePath);
      }
    }
  }

  private updateState(status: string, updates: { totalFiles?: number; totalChunks?: number; lastError?: string }): void {
    const { projectName } = this.options;
    
    this.db.prepare(`
      INSERT OR REPLACE INTO code_index_state 
      (project_name, status, total_files, total_chunks, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(projectName, status, updates.totalFiles || 0, updates.totalChunks || 0, updates.lastError || null);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

export default TwoPhaseCodeIndexer;
