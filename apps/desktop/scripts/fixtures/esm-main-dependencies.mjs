import { EventEmitter } from 'node:events';
import { Pool } from 'pg';

export const dependencyTypes = {
  eventEmitter: typeof EventEmitter,
  pool: typeof Pool,
};
