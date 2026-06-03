import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';

if (!config.databaseUrl) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
}

const queryClient = postgres(config.databaseUrl);
export const db = drizzle(queryClient);
