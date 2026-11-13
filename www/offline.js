/* www/js/offline.js
 * Offline data layer for Schools Manager (Capacitor + Supabase).
 *
 * Usage:
 *   <script src="js/offline.js"></script>
 *   Offline.init(supabaseClient);                 // once, after the client is created
 *   const rows = await Offline.list('subject_scores', r => r.class_name === 'JSS1');
 *   await Offline.save('subject_scores', record); // works offline, syncs later
 *   await Offline.remove('subject_scores', record.client_id);
 *   Offline.onStatus(s => badge.textContent = ...); // s = {state, pending, online}
 *   await Offline.clearAll();                     // call on logout
 */
(function () {
  // kind 'uuid'   = table id is already a UUID (id is used for syncing)
  // kind 'bigint' = numeric id; the new client_id column is used for syncing
  const TABLES = {
    school_profile:    { kind: 'bigint' },
    school_classes:    { kind: 'bigint' },
    class_students:    { kind: 'uuid' },
    student_photos:    { kind: 'bigint' },
    subject_scores:    { kind: 'bigint' },
    class_attendance:  { kind: 'bigint' },
    staff_assignments: { kind: 'bigint' },
    school_staff:      { kind: 'uuid' },
    fee_items:         { kind: 'uuid' },
    fee_students:      { kind: 'uuid' },
    fee_payments:      { kind: 'uuid' },
    announcements:     { kind: 'bigint' },
  };
  const NAMES = Object.keys(TABLES);
  const RECONCILE_MS = 6 * 60 * 60 * 1000; // check for server-side deletes every 6h
  const PAGE = 1000;

  const conflictCol = t => (TABLES[t].kind === 'uuid' ? 'id' : 'client_id');
  const uid = () => crypto.randomUUID();

  /* ---------- tiny IndexedDB wrapper ---------- */
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('schools_manager_offline', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        NAMES.forEach(n => d.createObjectStore(n, { keyPath: 'client_id' }));
        d.createObjectStore('outbox', { keyPath: 'key' });
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return openDB().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  const getAll = s => tx(s, 'readonly', o => o.getAll());
  const get = (s, k) => tx(s, 'readonly', o => o.get(k));
  const put = (s, v) => tx(s, 'readwrite', o => o.put(v));
  const del = (s, k) => tx(s, 'readwrite', o => o.delete(k));
  const clear = s => tx(s, 'readwrite', o => o.clear());
  function putMany(store, rows) {
    return openDB().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      rows.forEach(r => s.put(r));
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    }));
  }

  /* ---------- helpers ---------- */
  let sb = null;
  let websiteId = null;   // only this website's rows are downloaded
  let syncing = false;
  const listeners = [];

  function fromServer(t, row) {
    const r = { ...row };
    if (TABLES[t].kind === 'uuid') r.client_id = r.id;
    r._dirty = false;
    return r;
  }
  function toPayload(t, rec) {
    const p = { ...rec };
    delete p._dirty;
    delete p.updated_at;               // server trigger sets it
    if (TABLES[t].kind === 'uuid') delete p.client_id; // column does not exist
    else delete p.id;                  // let the server assign numeric id
    return p;
  }
  const isNetwork = e =>
    e instanceof TypeError || /fetch|network|timeout|offline/i.test((e && e.message) || '');

  async function pendingCount() {
    return (await getAll('outbox')).length;
  }
  async function emit(state, err) {
    const s = { state, pending: await pendingCount(), online: navigator.onLine, error: err ? (err.message || String(err)) : null };
    listeners.forEach(fn => { try { fn(s); } catch (_) {} });
  }

  /* ---------- public data API ---------- */
  async function list(table, filter) {
    if (!TABLES[table]) throw new Error('Not an offline table: ' + table);
    const rows = await getAll(table);
    return filter ? rows.filter(filter) : rows;
  }

  let syncTimer = null;
  function syncSoon() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 1000);
  }

  async function save(table, rec) {
    if (!TABLES[table]) throw new Error('Not an offline table: ' + table);
    const r = { ...rec };
    if (TABLES[table].kind === 'uuid') {
      r.id = r.id || uid();
      r.client_id = r.id;
    } else {
      r.client_id = r.client_id || uid();
    }
    r.updated_at = new Date().toISOString();
    r._dirty = true;
    await put(table, r);
    await put('outbox', { key: table + '|' + r.client_id, table, client_id: r.client_id, action: 'upsert', at: Date.now() });
    emit('pending');
    syncSoon();
    return r;
  }

  async function remove(table, clientId) {
    if (!TABLES[table]) throw new Error('Not an offline table: ' + table);
    await del(table, clientId);
    await put('outbox', { key: table + '|' + clientId, table, client_id: clientId, action: 'delete', at: Date.now() });
    emit('pending');
    syncSoon();
  }

  /* Insert-or-update many rows at once. Existing local rows are matched on the
   * table's natural key (e.g. class + session + term + match_key), so a re-upload
   * updates the same record instead of creating a duplicate. */
  const keyOf = (r, fields) => fields.map(f => String(r[f] ?? '')).join('\u0001');

  async function upsertManyByKey(table, keyFields, recs) {
    if (!TABLES[table]) throw new Error('Not an offline table: ' + table);
    const existing = new Map((await getAll(table)).map(r => [keyOf(r, keyFields), r]));
    const rows = [];
    const queue = [];
    const nowIso = new Date().toISOString();
    for (const rec of recs) {
      const k = keyOf(rec, keyFields);
      const old = existing.get(k);
      const r = old ? { ...old, ...rec } : { ...rec };
      if (TABLES[table].kind === 'uuid') {
        r.id = (old && old.id) || r.id || uid();
        r.client_id = r.id;
      } else {
        r.client_id = (old && old.client_id) || r.client_id || uid();
        if (old && old.id !== undefined) r.id = old.id;
      }
      r.updated_at = nowIso;
      r._dirty = true;
      existing.set(k, r);              // duplicates inside one upload merge together
      rows.push(r);
      queue.push({ key: table + '|' + r.client_id, table, client_id: r.client_id, action: 'upsert', at: Date.now() });
    }
    await putMany(table, rows);
    await putMany('outbox', queue);
    emit('pending');
    syncSoon();
    return rows.length;
  }

  /* Delete every local row for which fn(row) is true, and queue the deletes. */
  async function removeWhere(table, fn) {
    if (!TABLES[table]) throw new Error('Not an offline table: ' + table);
    const victims = (await getAll(table)).filter(fn);
    for (const v of victims) await del(table, v.client_id);
    await putMany('outbox', victims.map(v => ({
      key: table + '|' + v.client_id, table, client_id: v.client_id, action: 'delete', at: Date.now(),
    })));
    emit('pending');
    syncSoon();
    return victims.length;
  }

  /* ---------- sync ---------- */
  async function push() {
    const items = (await getAll('outbox')).sort((a, b) => a.at - b.at);
    for (const it of items) {
      try {
        if (it.action === 'delete') {
          const { error } = await sb.from(it.table).delete().eq(conflictCol(it.table), it.client_id);
          if (error) throw error;
          await del('outbox', it.key);
        } else {
          const rec = await get(it.table, it.client_id);
          if (!rec) { await del('outbox', it.key); continue; }
          const { data, error } = await sb.from(it.table)
            .upsert(toPayload(it.table, rec), { onConflict: conflictCol(it.table) })
            .select().single();
          if (error) throw error;
          const cur = await get(it.table, it.client_id);
          if (cur && cur.updated_at !== rec.updated_at) continue; // edited again while uploading; stays queued
          await put(it.table, fromServer(it.table, data));
          await del('outbox', it.key);
        }
      } catch (e) {
        if (isNetwork(e)) throw e;                 // stop; try again when online
        it.error = (e && e.message) || String(e);  // keep it queued, move on
        await put('outbox', it);
      }
    }
  }

  async function pull(t) {
    const metaKey = 'pulled:' + t;
    const since = (await get('meta', metaKey))?.v || null;
    const local = new Map((await getAll(t)).map(r => [r.client_id, r]));
    let from = 0, maxTs = since, rows;
    do {
      let q = sb.from(t).select('*')
        .order('updated_at', { ascending: true })
        .order(conflictCol(t), { ascending: true })
        .range(from, from + PAGE - 1);
      if (websiteId) q = q.eq('website_id', websiteId);
      if (since) q = q.gte('updated_at', since);
      const { data, error } = await q;
      if (error) throw error;
      rows = data || [];
      const batch = [];
      for (const row of rows) {
        if (!maxTs || row.updated_at > maxTs) maxTs = row.updated_at;
        const r = fromServer(t, row);
        const l = local.get(r.client_id);
        if (l && l._dirty) continue;     // never overwrite unsynced local edits
        batch.push(r);
      }
      if (batch.length) await putMany(t, batch);
      from += PAGE;
    } while (rows.length === PAGE);
    if (maxTs) await put('meta', { k: metaKey, v: maxTs });
  }

  // Removes local copies of rows that were deleted elsewhere (website, another phone).
  async function reconcile(t) {
    const metaKey = 'reconciled:' + t;
    const last = (await get('meta', metaKey))?.v || 0;
    if (Date.now() - last < RECONCILE_MS) return;
    const col = conflictCol(t);
    const ids = new Set();
    let from = 0, data;
    do {
      let rq = sb.from(t).select(col).order(col, { ascending: true }).range(from, from + PAGE - 1);
      if (websiteId) rq = rq.eq('website_id', websiteId);
      const r = await rq;
      if (r.error) throw r.error;
      data = r.data || [];
      data.forEach(x => ids.add(x[col]));
      from += PAGE;
    } while (data.length === PAGE);
    const queued = new Set((await getAll('outbox')).filter(o => o.table === t).map(o => o.client_id));
    for (const l of await getAll(t)) {
      if (!ids.has(l.client_id) && !l._dirty && !queued.has(l.client_id)) await del(t, l.client_id);
    }
    await put('meta', { k: metaKey, v: Date.now() });
  }

  async function sync() {
    if (syncing || !sb || !navigator.onLine) return;
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) return;
    syncing = true;
    emit('syncing');
    try {
      await push();
      for (const t of NAMES) {
        await pull(t);
        await reconcile(t);
      }
      syncing = false;
      emit('idle');
    } catch (e) {
      syncing = false;
      emit(isNetwork(e) ? 'offline' : 'error', e);
    }
  }

  async function clearAll() {
    for (const s of [...NAMES, 'outbox', 'meta']) await clear(s);
    emit('idle');
  }

  function init(client, opts) {
    sb = client;
    // Uses the page's WEBSITE_ID automatically, so two websites sharing one
    // Supabase project never download each other's rows.
    websiteId = (opts && opts.websiteId) || (typeof WEBSITE_ID !== 'undefined' ? WEBSITE_ID : null);
    window.addEventListener('online', sync);
    window.addEventListener('offline', () => emit('offline'));
    setInterval(sync, 60000);
    sync();
  }

  window.Offline = { init, list, save, remove, upsertManyByKey, removeWhere, sync, clearAll, onStatus: fn => listeners.push(fn), pending: pendingCount };
})();
