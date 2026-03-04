/**
 * Code indexing commands for qmd-cli
 * 
 * Usage:
 *   qmd code-index add <project-path> --name <project-name>
 *   qmd code-index status <project-name>
 *   qmd code-index search <query> --project <project-name>
 *   qmd code-index embed <project-name>  # Trigger Phase 2 (background)
 */

import type { Database } from '../db.js';
import { TwoPhaseCodeIndexer } from './indexer.js';
import * as path from 'path';
import * as fs from 'fs';

interface CodeIndexOptions {
  db: Database;
  projectPath?: string;
  projectName?: string;
  ollamaUrl?: string;
}

export async function addProject(options: CodeIndexOptions): Promise<void> {
  const { db, projectPath, projectName } = options;
  
  if (!projectPath || !projectName) {
    console.error('Usage: qmd code-index add <project-path> --name <project-name>');
    process.exit(1);
  }

  const resolvedPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Project path does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`📁 Indexing project: ${projectName}`);
  console.log(`📍 Path: ${resolvedPath}`);
  console.log('');

  const indexer = new TwoPhaseCodeIndexer(db, {
    projectPath: resolvedPath,
    projectName,
    onProgress: (progress) => {
      if (progress.phase === 'enumerating') {
        process.stdout.write('📂 Enumerating files...\r');
      } else if (progress.phase === 'indexing') {
        const pct = Math.round((progress.processedFiles / progress.totalFiles) * 100);
        process.stdout.write(`📊 Indexing: ${progress.processedFiles}/${progress.totalFiles} files (${pct}%) - ${progress.totalChunks} chunks\r`);
      }
    },
  });

  // Handle completion
  indexer.on('phase1Complete', ({ files, chunks }) => {
    console.log('');
    console.log(`✅ Phase 1 complete: ${files} files, ${chunks} chunks indexed`);
    console.log('🔍 Search available immediately via FTS5');
  });

  // Run Phase 1 (blocking)
  await indexer.phase1Index();

  console.log('');
  console.log('🚀 Starting Phase 2: Background embedding...');
  console.log('   (This will continue in the background)');
  
  // Start Phase 2 (non-blocking)
  indexer.phase2Embed(options.ollamaUrl || 'http://localhost:11434').then(() => {
    console.log('✅ Phase 2 complete: All embeddings generated');
  }).catch((error) => {
    console.error('❌ Phase 2 error:', error.message);
  });

  console.log('');
  console.log('💡 To check progress: qmd code-index status', projectName);
  console.log('💡 To search: qmd code-index search "<query>" --project', projectName);
}

export function getStatus(options: CodeIndexOptions): void {
  const { db, projectName } = options;
  
  // Check if code_index_files table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='code_index_files'
  `).get() as { name: string } | undefined;
  
  if (!tableExists) {
    console.log('No code projects indexed yet.');
    console.log('Run: qmd code-index add <path> --name <name>');
    return;
  }
  
  if (!projectName) {
    // List all indexed projects
    const projects = db.prepare(`
      SELECT DISTINCT project_name, 
        COUNT(*) as files,
        SUM(chunk_count) as chunks
      FROM code_index_files
      GROUP BY project_name
    `).all() as Array<{ project_name: string; files: number; chunks: number }>;

    if (projects.length === 0) {
      console.log('No code projects indexed yet.');
      console.log('Run: qmd code-index add <path> --name <name>');
      return;
    }

    console.log('📊 Indexed Code Projects');
    console.log('========================');
    for (const p of projects) {
      console.log(`${p.project_name}: ${p.files} files, ${p.chunks} chunks`);
    }
    return;
  }

  // Get specific project stats
  const indexer = new TwoPhaseCodeIndexer(db, { 
    projectPath: '', 
    projectName 
  });
  
  const stats = indexer.getStats(projectName);
  const hasEmbeddings = indexer.hasEmbeddings(projectName);

  console.log(`📊 Project: ${projectName}`);
  console.log('========================');
  console.log(`Files: ${stats.totalFiles}`);
  console.log(`Chunks: ${stats.totalChunks}`);
  console.log(`Embeddings: ${stats.embeddedChunks}/${stats.totalChunks} (${hasEmbeddings ? '✅ Complete' : '🔄 In Progress'})`);
  
  if (!hasEmbeddings && stats.totalChunks > 0) {
    const pct = Math.round((stats.embeddedChunks / stats.totalChunks) * 100);
    console.log(`Progress: ${pct}%`);
    console.log('');
    console.log('💡 Run: qmd code-index embed', projectName);
  }
}

export function searchCode(options: CodeIndexOptions & { query: string; limit?: number; semantic?: boolean }): void {
  const { db, projectName, query, limit = 10, semantic = false } = options;
  
  if (!projectName) {
    console.error('Usage: qmd code-index search "<query>" --project <project-name>');
    process.exit(1);
  }

  const indexer = new TwoPhaseCodeIndexer(db, { 
    projectPath: '', 
    projectName 
  });

  console.log(`🔍 Searching: "${query}"`);
  console.log(`📁 Project: ${projectName}`);
  console.log('');

  const startTime = Date.now();
  const results = indexer.search(query, { projectName, limit, useSemantic: semantic });
  const duration = Date.now() - startTime;

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`Found ${results.length} results in ${duration}ms`);
  console.log('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    console.log(`${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})`);
    if (r.symbolName) {
      console.log(`   Symbol: ${r.symbolName}`);
    }
    
    // Show snippet (first 3 lines)
    const lines = r.content.split('\n').slice(0, 3);
    console.log('   ' + lines.join('\n   '));
    if (r.content.split('\n').length > 3) {
      console.log('   ...');
    }
    console.log('');
  }
}

export async function triggerEmbedding(options: CodeIndexOptions): Promise<void> {
  const { db, projectName, ollamaUrl } = options;
  
  if (!projectName) {
    console.error('Usage: qmd code-index embed <project-name>');
    process.exit(1);
  }

  const indexer = new TwoPhaseCodeIndexer(db, { 
    projectPath: '', 
    projectName 
  });

  const stats = indexer.getStats(projectName);
  
  if (stats.totalChunks === 0) {
    console.error('Error: No chunks found. Run Phase 1 first:');
    console.error(`  qmd code-index add <path> --name ${projectName}`);
    process.exit(1);
  }

  if (stats.embeddedChunks === stats.totalChunks) {
    console.log('✅ All chunks already have embeddings');
    return;
  }

  console.log(`🚀 Generating embeddings for ${projectName}...`);
  console.log(`   Chunks to embed: ${stats.totalChunks - stats.embeddedChunks}`);
  console.log('');

  let lastProgress = 0;
  indexer.on('progress', (progress) => {
    if (progress.phase === 'embedding') {
      const pct = Math.round((progress.embeddedChunks / progress.totalChunks) * 100);
      if (pct !== lastProgress) {
        process.stdout.write(`📊 Embedding: ${pct}% (${progress.embeddedChunks}/${progress.totalChunks})\r`);
        lastProgress = pct;
      }
    }
  });

  await indexer.phase2Embed(ollamaUrl || 'http://localhost:11434');

  console.log('');
  console.log('✅ Embedding complete!');
}

export function removeProject(options: CodeIndexOptions): void {
  const { db, projectName } = options;
  
  if (!projectName) {
    console.error('Usage: qmd code-index remove <project-name>');
    process.exit(1);
  }

  const result = db.prepare('DELETE FROM code_index_files WHERE project_name = ?').run(projectName);
  
  console.log(`🗑️  Removed project: ${projectName}`);
  console.log(`   Deleted ${result.changes} files`);
}
