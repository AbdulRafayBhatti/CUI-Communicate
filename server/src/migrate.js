import 'dotenv/config';
import mongoose from 'mongoose';
import { runMigrations } from './services/migration.js';

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing. Set it in server/.env first.');
  await mongoose.connect(process.env.MONGO_URI);
  await runMigrations({ log: console.log });
  await mongoose.disconnect();
}
main().catch(async e => { console.error('Migration failed:', e.message); await mongoose.disconnect().catch(() => {}); process.exitCode = 1; });
