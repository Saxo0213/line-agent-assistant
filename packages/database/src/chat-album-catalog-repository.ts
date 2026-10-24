import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ConversationKey } from '@line-agent/contracts';

export type ChatAlbumCatalogAlbum = Readonly<{ albumId: string; chatId: string; title: string | null; photoCount: number | null; createTime: number | null; updateTime: number | null }>;
export type ChatAlbumCatalogPhoto = Readonly<{ photoId: string; oid: string; prefix: 'album/a' | 'album/v'; shotTime: number | null; width: number | null; height: number | null }>;
export type ChatAlbumSavedFile = Readonly<{ folderName: string; fileName: string; contentHash: string; byteCount: number; revision: number; savedAt: string }>;
export type ChatAlbumCatalogPage<T> = Readonly<{ items: T[]; nextCursor: string | null }>;
export type ChatAlbumCatalogBinding = Readonly<{ workerInstanceId: string; controlEpoch: number; mode: string }>;
export type ChatAlbumCatalogScan = Readonly<{ complete: boolean; generation: number; cursor: string | null; previousCursor: string | null; nextOrdinal: number }>;

const pageSize = (value: number) => Math.max(1, Math.min(50, Math.trunc(value)));
const numberOrNull = (value: Date | null): number | null => value?.getTime() ?? null;

export class ChatAlbumCatalogRepository {
  constructor(private readonly pool: Pool) {}

  private bindingCte(controlEpochParameter: number, workerInstanceParameter: number, alias = 'authority') {
    return `WITH ${alias} AS MATERIALIZED (
      SELECT 1 FROM account_control ac JOIN line_accounts a ON a.account_id=$1
      WHERE ac.singleton=true AND ac.control_epoch=$${controlEpochParameter} AND a.mode='ACTIVE_CONTROL'
        AND a.worker_instance_id=$${workerInstanceParameter} AND a.worker_binding_epoch=$${controlEpochParameter}
      FOR SHARE OF ac,a)`;
  }

  private bindingValues(binding: ChatAlbumCatalogBinding): unknown[] {
    if (binding.mode !== 'ACTIVE_CONTROL' || !Number.isSafeInteger(binding.controlEpoch) || binding.controlEpoch < 0 || !binding.workerInstanceId) {
      throw new Error('Album catalog write has no current active binding.');
    }
    return [binding.controlEpoch, binding.workerInstanceId];
  }

  async albumScan(key: ConversationKey, _binding?: ChatAlbumCatalogBinding): Promise<{ complete: boolean; generation: number }> {
    const result = await this.pool.query<{ complete: boolean; scan_generation: string }>(
      'SELECT complete,scan_generation FROM chat_album_scans WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [key.accountId, key.chatType, key.chatId]);
    const row = result.rows[0];
    return row ? { complete: row.complete, generation: Number(row.scan_generation) } : { complete: false, generation: 0 };
  }

  async beginAlbumScan(key: ConversationKey, binding: ChatAlbumCatalogBinding): Promise<number> {
    const values = this.bindingValues(binding);
    const result = await this.pool.query<{ scan_generation: string }>(
      `${this.bindingCte(4, 5)} INSERT INTO chat_album_scans(account_id,chat_type,chat_id,scan_generation,complete,line_cursor,previous_line_cursor,next_ordinal)
       SELECT $1,$2,$3,1,false,NULL,NULL,0 FROM authority
       ON CONFLICT(account_id,chat_type,chat_id) DO UPDATE SET scan_generation=chat_album_scans.scan_generation+1,complete=false,
         line_cursor=NULL,previous_line_cursor=NULL,previous_page_hash=NULL,next_ordinal=0,updated_at=now()
      RETURNING scan_generation`, [key.accountId, key.chatType, key.chatId, ...values]);
    if (!result.rows[0]) throw new Error('Album catalog binding changed before scan start.');
    return Number(result.rows[0]!.scan_generation);
  }

  async albumScanState(key: ConversationKey): Promise<ChatAlbumCatalogScan> {
    const result = await this.pool.query<{ complete: boolean; scan_generation: string; line_cursor: string | null; previous_line_cursor: string | null; next_ordinal: string }>(
      'SELECT complete,scan_generation,line_cursor,previous_line_cursor,next_ordinal FROM chat_album_scans WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3',
      [key.accountId, key.chatType, key.chatId]);
    const row = result.rows[0];
    return row ? { complete: row.complete, generation: Number(row.scan_generation), cursor: row.line_cursor,
      previousCursor: row.previous_line_cursor, nextOrdinal: Number(row.next_ordinal) }
      : { complete: false, generation: 0, cursor: null, previousCursor: null, nextOrdinal: 0 };
  }

  private async assertBound(client: PoolClient, key: ConversationKey, binding: ChatAlbumCatalogBinding): Promise<void> {
    const [epoch, worker] = this.bindingValues(binding);
    const result = await client.query(`${this.bindingCte(4, 5)} SELECT 1 FROM authority CROSS JOIN (SELECT $2::text,$3::text) AS scoped`,
      [key.accountId, key.chatType, key.chatId, epoch, worker]);
    if (!result.rowCount) throw new Error('Album catalog binding changed during page append.');
  }

  async appendAlbumPage(key: ConversationKey, generation: number, expectedCursor: string | null,
    albums: readonly ChatAlbumCatalogAlbum[], nextCursor: string | null, binding: ChatAlbumCatalogBinding): Promise<{ nextOrdinal: number; complete: boolean }> {
    const client = await this.pool.connect();
    const pageHash = createHash('sha256').update(JSON.stringify(albums)).digest('hex');
    try {
      await client.query('BEGIN');
      await this.assertBound(client, key, binding);
      const locked = await client.query<{ line_cursor: string | null; previous_line_cursor: string | null; previous_page_hash: string | null; next_ordinal: string; complete: boolean }>(
        'SELECT line_cursor,previous_line_cursor,previous_page_hash,next_ordinal,complete FROM chat_album_scans WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND scan_generation=$4 FOR UPDATE',
        [key.accountId, key.chatType, key.chatId, generation]);
      const state = locked.rows[0];
      if (!state) throw new Error('Album catalog scan generation changed.');
      const replay = (state.complete || state.line_cursor !== null) && state.previous_line_cursor === expectedCursor && state.line_cursor === nextCursor
        && state.previous_page_hash === pageHash;
      if (state.complete && !replay) throw new Error('Album catalog scan is complete; only an exact page replay is allowed.');
      if (!replay && state.line_cursor !== expectedCursor) throw new Error('Album catalog page cursor changed; caller must resume current scan.');
      if (!replay) {
        for (let index = 0; index < albums.length; index += 1) {
          const album = albums[index]!;
          await client.query(`INSERT INTO chat_albums(account_id,chat_type,chat_id,album_id,title,photo_count,create_time,update_time,list_generation,list_ordinal)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,chat_type,chat_id,album_id) DO UPDATE SET title=EXCLUDED.title,
            photo_count=EXCLUDED.photo_count,create_time=EXCLUDED.create_time,update_time=EXCLUDED.update_time,list_generation=EXCLUDED.list_generation,
            list_ordinal=CASE WHEN chat_albums.list_generation=EXCLUDED.list_generation THEN chat_albums.list_ordinal ELSE EXCLUDED.list_ordinal END,
            photo_scan_generation=CASE WHEN chat_albums.photo_count IS DISTINCT FROM EXCLUDED.photo_count
              OR chat_albums.update_time IS DISTINCT FROM EXCLUDED.update_time THEN chat_albums.photo_scan_generation+1 ELSE chat_albums.photo_scan_generation END,
            photo_scan_cursor=CASE WHEN chat_albums.photo_count IS DISTINCT FROM EXCLUDED.photo_count OR chat_albums.update_time IS DISTINCT FROM EXCLUDED.update_time THEN NULL ELSE chat_albums.photo_scan_cursor END,
            photo_scan_previous_cursor=CASE WHEN chat_albums.photo_count IS DISTINCT FROM EXCLUDED.photo_count OR chat_albums.update_time IS DISTINCT FROM EXCLUDED.update_time THEN NULL ELSE chat_albums.photo_scan_previous_cursor END,
            photo_scan_previous_page_hash=CASE WHEN chat_albums.photo_count IS DISTINCT FROM EXCLUDED.photo_count OR chat_albums.update_time IS DISTINCT FROM EXCLUDED.update_time THEN NULL ELSE chat_albums.photo_scan_previous_page_hash END,
            photo_scan_next_ordinal=CASE WHEN chat_albums.photo_count IS DISTINCT FROM EXCLUDED.photo_count OR chat_albums.update_time IS DISTINCT FROM EXCLUDED.update_time THEN 0 ELSE chat_albums.photo_scan_next_ordinal END,
            photo_list_complete=CASE WHEN chat_albums.photo_count IS DISTINCT FROM EXCLUDED.photo_count OR chat_albums.update_time IS DISTINCT FROM EXCLUDED.update_time THEN false ELSE chat_albums.photo_list_complete END,updated_at=now()`,
          [key.accountId,key.chatType,key.chatId,album.albumId,album.title,album.photoCount,album.createTime===null?null:new Date(album.createTime),album.updateTime===null?null:new Date(album.updateTime),generation,Number(state.next_ordinal)+index]);
        }
        await this.assertBound(client, key, binding);
        const advanced = await client.query(`UPDATE chat_album_scans SET previous_line_cursor=$5,line_cursor=$6,next_ordinal=next_ordinal+$7,complete=$6::text IS NULL,previous_page_hash=$8,updated_at=now()
          WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND scan_generation=$4`,
        [key.accountId,key.chatType,key.chatId,generation,expectedCursor,nextCursor,albums.length,pageHash]);
        if (advanced.rowCount !== 1) throw new Error('Album catalog scan generation changed.');
      }
      await client.query('COMMIT');
      return { nextOrdinal: Number(state.next_ordinal)+(replay?0:albums.length), complete: nextCursor === null };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async listAlbums(key: ConversationKey, cursor: string | null, limit = 50): Promise<ChatAlbumCatalogPage<ChatAlbumCatalogAlbum>> {
    const bounded = pageSize(limit);
    const result = await this.pool.query<{ album_id: string; chat_id: string; title: string | null; photo_count: number | null; create_time: Date | null; update_time: Date | null; list_ordinal: string }>(
      `SELECT a.album_id,a.chat_id,a.title,a.photo_count,a.create_time,a.update_time,a.list_ordinal FROM chat_albums a
       JOIN chat_album_scans s USING(account_id,chat_type,chat_id)
       WHERE a.account_id=$1 AND a.chat_type=$2 AND a.chat_id=$3 AND a.list_generation=s.scan_generation
         AND a.list_ordinal>$4 ORDER BY a.list_ordinal LIMIT $5`,
      [key.accountId, key.chatType, key.chatId, cursor === null ? -1 : Number(cursor), bounded + 1]);
    const rows = result.rows.slice(0, bounded);
    return { items: rows.map((row) => ({ albumId: row.album_id, chatId: row.chat_id, title: row.title, photoCount: row.photo_count,
      createTime: numberOrNull(row.create_time), updateTime: numberOrNull(row.update_time) })),
      nextCursor: result.rows.length > bounded ? String(rows.at(-1)!.list_ordinal) : null };
  }

  async firstPhotoIds(key: ConversationKey, albumIds: readonly string[], limit = 2): Promise<Map<string, string[]>> {
    const ids = albumIds.slice(0, 50);
    if (!ids.length) return new Map();
    const bounded = Math.max(1, Math.min(2, Math.trunc(limit)));
    const result = await this.pool.query<{ album_id: string; photo_id: string }>(
      `SELECT album_id,photo_id FROM (
         SELECT p.album_id,p.photo_id,row_number() OVER(PARTITION BY p.album_id ORDER BY p.photo_scan_ordinal) AS position
         FROM chat_album_photos p JOIN chat_albums a USING(account_id,chat_type,chat_id,album_id)
         WHERE p.account_id=$1 AND p.chat_type=$2 AND p.chat_id=$3 AND p.album_id=ANY($4::text[])
           AND p.photo_scan_generation=a.photo_scan_generation AND p.archive_folder IS NOT NULL
       ) photos WHERE position<=$5 ORDER BY album_id,position`,
      [key.accountId, key.chatType, key.chatId, ids, bounded]);
    const output = new Map<string, string[]>();
    for (const row of result.rows) output.set(row.album_id, [...(output.get(row.album_id) ?? []), row.photo_id]);
    return output;
  }

  async beginPhotoScan(key: ConversationKey, albumId: string, binding: ChatAlbumCatalogBinding): Promise<number> {
    const [controlEpoch, workerInstanceId] = this.bindingValues(binding);
    const result = await this.pool.query<{ photo_scan_generation: string }>(
      `${this.bindingCte(5, 6)} UPDATE chat_albums SET photo_scan_generation=photo_scan_generation+1,photo_scan_cursor=NULL,photo_scan_previous_cursor=NULL,photo_scan_previous_page_hash=NULL,photo_scan_next_ordinal=0,photo_list_complete=false,updated_at=now()
       WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND album_id=$4 AND EXISTS(SELECT 1 FROM authority) RETURNING photo_scan_generation`,
      [key.accountId, key.chatType, key.chatId, albumId, controlEpoch, workerInstanceId]);
    if (!result.rows[0]) throw new Error('Album is missing from the chat catalog.');
    return Number(result.rows[0].photo_scan_generation);
  }

  async appendPhotoPage(key: ConversationKey, albumId: string, generation: number, expectedCursor: string | null,
    photos: readonly ChatAlbumCatalogPhoto[], nextCursor: string | null, binding: ChatAlbumCatalogBinding): Promise<{ nextOrdinal: number; complete: boolean }> {
    const client = await this.pool.connect();
    const pageHash = createHash('sha256').update(JSON.stringify(photos)).digest('hex');
    try {
      await client.query('BEGIN');
      await this.assertBound(client,key,binding);
      const locked = await client.query<{ photo_scan_cursor: string | null; photo_scan_previous_cursor: string | null; photo_scan_previous_page_hash: string | null; photo_scan_next_ordinal: string; photo_list_complete: boolean }>(
        'SELECT photo_scan_cursor,photo_scan_previous_cursor,photo_scan_previous_page_hash,photo_scan_next_ordinal,photo_list_complete FROM chat_albums WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND album_id=$4 AND photo_scan_generation=$5 FOR UPDATE',
        [key.accountId,key.chatType,key.chatId,albumId,generation]);
      const state=locked.rows[0]; if(!state) throw new Error('Album photo scan generation changed.');
      const replay=(state.photo_scan_cursor!==null || state.photo_list_complete) && state.photo_scan_previous_cursor===expectedCursor && state.photo_scan_cursor===nextCursor
        && state.photo_scan_previous_page_hash===pageHash;
      if(state.photo_list_complete && !replay) throw new Error('Album photo scan is complete; only an exact page replay is allowed.');
      if(!replay && state.photo_scan_cursor!==expectedCursor) throw new Error('Album photo page cursor changed; caller must resume current scan.');
      if(!replay) {
        for(let index=0;index<photos.length;index+=1) {
          const photo=photos[index]!;
          await client.query(`INSERT INTO chat_album_photos(account_id,chat_type,chat_id,album_id,photo_id,oid,prefix,shot_time,width,height,photo_scan_generation,photo_scan_ordinal)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(account_id,chat_type,chat_id,album_id,photo_id) DO UPDATE SET oid=EXCLUDED.oid,prefix=EXCLUDED.prefix,
            shot_time=EXCLUDED.shot_time,width=EXCLUDED.width,height=EXCLUDED.height,
            photo_scan_ordinal=CASE WHEN chat_album_photos.photo_scan_generation=EXCLUDED.photo_scan_generation THEN chat_album_photos.photo_scan_ordinal ELSE EXCLUDED.photo_scan_ordinal END,
            photo_scan_generation=EXCLUDED.photo_scan_generation,updated_at=now()`,
          [key.accountId,key.chatType,key.chatId,albumId,photo.photoId,photo.oid,photo.prefix,photo.shotTime===null?null:new Date(photo.shotTime),photo.width,photo.height,generation,Number(state.photo_scan_next_ordinal)+index]);
        }
        await this.assertBound(client,key,binding);
        const advanced=await client.query(`UPDATE chat_albums SET photo_scan_previous_cursor=$6,photo_scan_cursor=$7,photo_scan_next_ordinal=photo_scan_next_ordinal+$8,
          photo_list_complete=$7::text IS NULL,photo_scan_previous_page_hash=$9,updated_at=now() WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND album_id=$4 AND photo_scan_generation=$5`,
        [key.accountId,key.chatType,key.chatId,albumId,generation,expectedCursor,nextCursor,photos.length,pageHash]);
        if(advanced.rowCount!==1) throw new Error('Album photo scan generation changed.');
      }
      await client.query('COMMIT');
      return {nextOrdinal:Number(state.photo_scan_next_ordinal)+(replay?0:photos.length),complete:nextCursor===null};
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally {client.release();}
  }

  async photoScan(key: ConversationKey, albumId: string): Promise<{ complete: boolean; generation: number; cursor: string | null; previousCursor: string | null; nextOrdinal: number } | null> {
    const result = await this.pool.query<{ photo_list_complete: boolean; photo_scan_generation: string; photo_scan_cursor: string | null; photo_scan_previous_cursor: string | null; photo_scan_next_ordinal: string }>(
      'SELECT photo_list_complete,photo_scan_generation,photo_scan_cursor,photo_scan_previous_cursor,photo_scan_next_ordinal FROM chat_albums WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND album_id=$4',
      [key.accountId, key.chatType, key.chatId, albumId]);
    const row = result.rows[0];
    return row ? { complete: row.photo_list_complete, generation: Number(row.photo_scan_generation), cursor: row.photo_scan_cursor,
      previousCursor: row.photo_scan_previous_cursor, nextOrdinal: Number(row.photo_scan_next_ordinal) } : null;
  }

  async listPhotos(key: ConversationKey, albumId: string, cursor: string | null, limit = 50): Promise<ChatAlbumCatalogPage<ChatAlbumCatalogPhoto>> {
    const bounded = pageSize(limit);
    const result = await this.pool.query<{ photo_id: string; oid: string; prefix: 'album/a' | 'album/v'; shot_time: Date | null; width: number | null; height: number | null; photo_scan_ordinal: string }>(
      `SELECT p.photo_id,p.oid,p.prefix,p.shot_time,p.width,p.height,p.photo_scan_ordinal FROM chat_album_photos p JOIN chat_albums a
       USING(account_id,chat_type,chat_id,album_id)
       WHERE p.account_id=$1 AND p.chat_type=$2 AND p.chat_id=$3 AND p.album_id=$4
       AND p.photo_scan_generation=a.photo_scan_generation AND p.photo_scan_ordinal>$5
       ORDER BY p.photo_scan_ordinal LIMIT $6`, [key.accountId, key.chatType, key.chatId, albumId, cursor === null ? -1 : Number(cursor), bounded + 1]);
    const rows = result.rows.slice(0, bounded);
    return { items: rows.map((row) => ({ photoId: row.photo_id, oid: row.oid, prefix: row.prefix, shotTime: numberOrNull(row.shot_time), width: row.width, height: row.height })),
      nextCursor: result.rows.length > bounded ? String(rows.at(-1)!.photo_scan_ordinal) : null };
  }

  async savePhoto(key: ConversationKey, albumId: string, photoId: string, file: ChatAlbumSavedFile, binding: ChatAlbumCatalogBinding): Promise<void> {
    const [controlEpoch, workerInstanceId] = this.bindingValues(binding);
    const result = await this.pool.query(`${this.bindingCte(12, 13)} UPDATE chat_album_photos SET archive_folder=$6,archive_file_name=$7,content_hash=$8,byte_count=$9,
      archive_revision=$10,saved_at=$11,updated_at=now() WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND album_id=$4 AND photo_id=$5
        AND EXISTS(SELECT 1 FROM authority)`,
    [key.accountId, key.chatType, key.chatId, albumId, photoId, file.folderName, file.fileName, file.contentHash, file.byteCount, file.revision, file.savedAt, controlEpoch, workerInstanceId]);
    if (result.rowCount !== 1) throw new Error('Album photo is missing from the chat catalog.');
  }

  async savedPhoto(key: ConversationKey, albumId: string, photoId: string): Promise<ChatAlbumSavedFile | null> {
    const result = await this.pool.query<{ archive_folder: string | null; archive_file_name: string | null; content_hash: string | null;
      byte_count: string | null; archive_revision: string | null; saved_at: Date | null }>(
      `SELECT archive_folder,archive_file_name,content_hash,byte_count,archive_revision,saved_at FROM chat_album_photos
       WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND album_id=$4 AND photo_id=$5`,
      [key.accountId, key.chatType, key.chatId, albumId, photoId]);
    const row = result.rows[0];
    if (!row || row.archive_folder === null || row.archive_file_name === null || row.content_hash === null || row.byte_count === null
      || row.archive_revision === null || row.saved_at === null) return null;
    return { folderName: row.archive_folder, fileName: row.archive_file_name, contentHash: row.content_hash,
      byteCount: Number(row.byte_count), revision: Number(row.archive_revision), savedAt: row.saved_at.toISOString() };
  }

  async clearSavedPhoto(key: ConversationKey, albumId: string, photoId: string, binding: ChatAlbumCatalogBinding): Promise<void> {
    const [controlEpoch, workerInstanceId] = this.bindingValues(binding);
    await this.pool.query(`${this.bindingCte(6, 7)} UPDATE chat_album_photos SET archive_folder=NULL,archive_file_name=NULL,content_hash=NULL,byte_count=NULL,
      archive_revision=NULL,saved_at=NULL,updated_at=now() WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND album_id=$4 AND photo_id=$5
        AND EXISTS(SELECT 1 FROM authority)`, [key.accountId, key.chatType, key.chatId, albumId, photoId, controlEpoch, workerInstanceId]);
  }
}
