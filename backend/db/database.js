'use strict';
/**
 * db/database.js — Client Supabase + fallback mémoire
 *
 * Expose un objet `db` avec les méthodes CRUD abstraites.
 * En production : Supabase/Postgres
 * En dev sans config : store mémoire (données perdues au restart)
 */

const Logger = require('../utils/logger');

// ── Adaptateur Supabase ───────────────────────────────────────
class SupabaseDB {
  constructor(client) { this._sb = client; }

  async findOne(table, filters = {}) {
    let q = this._sb.from(table).select('*');
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q.single();
    if (error?.code === 'PGRST116') return null;
    if (error) throw new Error(`DB.findOne(${table}): ${error.message}`);
    return data;
  }

  async findMany(table, filters = {}, opts = {}) {
    let q = this._sb.from(table).select(opts.select || '*');
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    if (opts.order)  q = q.order(opts.order, { ascending: opts.asc ?? false });
    if (opts.limit)  q = q.limit(opts.limit);
    if (opts.offset) q = q.range(opts.offset, opts.offset + (opts.limit || 100) - 1);
    const { data, error } = await q;
    if (error) throw new Error(`DB.findMany(${table}): ${error.message}`);
    return data || [];
  }

  async insert(table, row) {
    const { data, error } = await this._sb.from(table).insert(row).select().single();
    if (error) throw new Error(`DB.insert(${table}): ${error.message}`);
    return data;
  }

  async upsert(table, row, conflict) {
    const { data, error } = await this._sb.from(table)
      .upsert(row, { onConflict: conflict }).select().single();
    if (error) throw new Error(`DB.upsert(${table}): ${error.message}`);
    return data;
  }

  async update(table, filters, patch) {
    let q = this._sb.from(table).update({ ...patch, updated_at: new Date().toISOString() });
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q.select();
    if (error) throw new Error(`DB.update(${table}): ${error.message}`);
    return data || [];
  }

  async delete(table, filters) {
    let q = this._sb.from(table).delete();
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw new Error(`DB.delete(${table}): ${error.message}`);
  }

  async count(table, filters = {}) {
    let q = this._sb.from(table).select('*', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { count, error } = await q;
    if (error) throw new Error(`DB.count(${table}): ${error.message}`);
    return count || 0;
  }

  async rawSql(sql, params = []) {
    const { data, error } = await this._sb.rpc('exec_sql', { sql, params });
    if (error) throw new Error(`DB.rawSql: ${error.message}`);
    return data;
  }
}

// ── Adaptateur mémoire (dev) ──────────────────────────────────
class MemoryDB {
  constructor() {
    this._tables = {};
    Logger.warn('database', 'MEMORY_MODE', { note: 'Données non persistées — configurer SUPABASE_URL' });
  }

  _tbl(name)  { if (!this._tables[name]) this._tables[name] = []; return this._tables[name]; }
  _uuid()     { return 'mem-' + Math.random().toString(36).slice(2); }
  _match(row, filters) { return Object.entries(filters).every(([k, v]) => row[k] === v); }

  async findOne(table, filters = {}) {
    return this._tbl(table).find(r => this._match(r, filters)) || null;
  }
  async findMany(table, filters = {}, opts = {}) {
    let rows = this._tbl(table).filter(r => this._match(r, filters));
    if (opts.limit) rows = rows.slice(opts.offset || 0, (opts.offset || 0) + opts.limit);
    return rows;
  }
  async insert(table, row) {
    const rec = { id: this._uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row };
    this._tbl(table).push(rec);
    return rec;
  }
  async upsert(table, row, conflict) {
    const filters = typeof conflict === 'string'
      ? Object.fromEntries(conflict.split(',').map(k => [k.trim(), row[k.trim()]]))
      : conflict;
    const idx = this._tbl(table).findIndex(r => this._match(r, filters));
    const rec = { id: this._uuid(), created_at: new Date().toISOString(), ...row, updated_at: new Date().toISOString() };
    if (idx >= 0) { this._tbl(table)[idx] = { ...this._tbl(table)[idx], ...rec }; return this._tbl(table)[idx]; }
    this._tbl(table).push(rec);
    return rec;
  }
  async update(table, filters, patch) {
    const rows = this._tbl(table).filter(r => this._match(r, filters));
    rows.forEach(r => Object.assign(r, patch, { updated_at: new Date().toISOString() }));
    return rows;
  }
  async delete(table, filters) {
    this._tables[table] = this._tbl(table).filter(r => !this._match(r, filters));
  }
  async count(table, filters = {}) {
    return this._tbl(table).filter(r => this._match(r, filters)).length;
  }
  async rawSql() { throw new Error('rawSql non supporté en mode mémoire'); }
}

// ── Singleton ─────────────────────────────────────────────────
let _db = null;

function getDB() {
  if (_db) return _db;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (url && key) {
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    _db = new SupabaseDB(client);
    Logger.info('database', 'CONNECTED', { url: url.replace(/https?:\/\//, '').slice(0, 20) + '...' });
  } else {
    _db = new MemoryDB();
  }

  return _db;
}

module.exports = { getDB };
