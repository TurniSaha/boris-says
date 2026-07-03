import { describe, it, expect } from 'vitest';
import { namesDestructiveDataOp } from '../src/brain/destructive-op.js';

describe('namesDestructiveDataOp — deterministic data-destruction detection (item 7)', () => {
  it('fires on SQL DDL/DML destruction', () => {
    expect(namesDestructiveDataOp('DROP the users table in prod and re-run the migration')).toBe(true);
    expect(namesDestructiveDataOp('drop table sessions')).toBe(true);
    expect(namesDestructiveDataOp('DELETE FROM orders where created < 2020')).toBe(true);
    expect(namesDestructiveDataOp('truncate table audit_log')).toBe(true);
    expect(namesDestructiveDataOp('TRUNCATE events')).toBe(true);
    expect(namesDestructiveDataOp('drop database analytics')).toBe(true);
  });

  it('fires on a destructive PROD migration phrased in prose', () => {
    expect(namesDestructiveDataOp('wipe the production users table and reseed')).toBe(true);
    expect(namesDestructiveDataOp('purge all records from the prod database')).toBe(true);
  });

  it('does NOT fire on innocent prose (the precision wall)', () => {
    expect(namesDestructiveDataOp('drop me a note when the build is green')).toBe(false);
    expect(namesDestructiveDataOp('add a dropdown menu to the settings page')).toBe(false);
    expect(namesDestructiveDataOp('add a drop shadow to the card')).toBe(false);
    expect(namesDestructiveDataOp('delete the comment in the code above line 40')).toBe(false);
    expect(namesDestructiveDataOp('delete this unused import')).toBe(false);
    expect(namesDestructiveDataOp('why did the deploy drop connections?')).toBe(false);
    expect(namesDestructiveDataOp('refactor the whole module, it is a mess')).toBe(false);
    expect(namesDestructiveDataOp('')).toBe(false);
  });

  it('a bare "delete the file" is NOT a persistent-data destruction', () => {
    expect(namesDestructiveDataOp('delete the old config file')).toBe(false);
  });
});
