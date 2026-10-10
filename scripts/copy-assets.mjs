// Copies non-TS runtime assets (prompt text, SQL migrations) into dist/.
import { cpSync } from 'node:fs';

cpSync('src/parser/system-prompt.md', 'dist/parser/system-prompt.md');
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
