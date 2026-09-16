import { findAll } from './files.js';

const [pattern = '**/*', root = process.cwd()] = process.argv.slice(2);
for (const path of findAll(pattern, root)) console.log(path);
