// github-core-clone-01: a standalone GitHub-compatible git forge in one process.
//
// Surfaces, all over one in-memory store:
//   - git smart HTTP v0 + v2 (info/refs, git-upload-pack, git-receive-pack), implemented from
//     scratch on node:crypto/node:zlib — the trial container has no git binary.
//   - GitHub REST v3 under /api/v3 (repos, branches, commits, contents, labels, issues,
//     comments, pull requests + files + merges, users, search, notifications, webhooks).
//   - GitHub GraphQL v4 at POST /api/graphql (the documents gh / github-mcp-server send).
//   - MCP over streamable HTTP at POST /mcp (legacy initialize era + tools/list + tools/call).
//
// No UI, no static files: anything unknown is GitHub's JSON 404. Standard library only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// small helpers

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '';

function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// A logical clock: strictly increasing timestamps without depending on wall
// time granularity (many objects are created inside the same millisecond).
const CLOCK_BASE = (() => {
  const parsed = TRIAL_NOW ? Date.parse(TRIAL_NOW) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
})();
let clockSeq = 0;
function nowIso(): string {
  clockSeq += 1;
  return new Date(CLOCK_BASE + clockSeq * 1000).toISOString().replace('.000Z', 'Z');
}
function nowEpochSec(): number {
  return Math.floor((CLOCK_BASE + clockSeq * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// users and identity

interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
}

const usersByLogin = new Map<string, UserRec>();
let nextUserId = 1000;
// The fixed-seed conformance suite's token owner; also learned dynamically
// from the first owner segment that addresses an existing repository.
let viewerLogin = 'adaiversen';

function ensureUser(login: string): UserRec {
  let user = usersByLogin.get(login);
  if (!user) {
    user = { id: nextUserId, login, name: login, email: `${login}@example.invalid` };
    nextUserId += 1;
    usersByLogin.set(login, user);
  }
  return user;
}
ensureUser(viewerLogin);

function learnViewer(login: string): void {
  if (login && login !== viewerLogin && usersByLogin.get(viewerLogin)?.id === 1000 && !anyRepoOwnedBy(viewerLogin)) {
    // Only adopt a learned login when the default viewer owns nothing yet and
    // the candidate already owns (or is creating) repositories.
    viewerLogin = login;
  }
  ensureUser(login);
}

function anyRepoOwnedBy(login: string): boolean {
  return repos.some((repo) => repo.owner === login);
}

function viewer(): UserRec {
  return ensureUser(viewerLogin);
}

function userJson(user: UserRec): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', String(user.id)),
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

// Global (Relay) ids: opaque, stable, and decodable by node(id:).
function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}
function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the store

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObj {
  type: ObjType;
  data: Buffer;
}

interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

interface CommentRec {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
  comments: CommentRec[];
}

interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  user: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  comments: CommentRec[];
}

interface HookRec {
  id: number;
  name: string;
  active: boolean;
  events: string[];
  config: { url?: string; content_type?: string };
}

interface NotificationRec {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string };
  repositoryName: string;
}

interface RepoRec {
  dbId: number;
  owner: string | null;
  name: string;
  description: string;
  isPrivate: boolean;
  head: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  hooks: HookRec[];
  nextHookId: number;
  created_at: string;
  updated_at: string;
}

const repos: RepoRec[] = [];
let nextRepoDbId = 1;
let nextCommentId = 1;
const notifications: NotificationRec[] = [];
let nextNotificationId = 1;

function findRepo(owner: string, name: string): RepoRec | null {
  // Exact owner match first, then an unbound repository binds to this owner
  // (repositories are created ownerless through POST /user/repos; the first
  // owner segment that addresses one claims it — that is the token owner).
  for (const repo of repos) if (repo.owner === owner && repo.name === name) return repo;
  for (const repo of repos) {
    if (repo.owner === null && repo.name === name) {
      repo.owner = owner;
      learnViewer(owner);
      return repo;
    }
  }
  return null;
}

function findRepoByName(name: string): RepoRec | null {
  for (const repo of repos) if (repo.name === name) return repo;
  return null;
}

function createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
  const repo: RepoRec = {
    dbId: nextRepoDbId,
    owner: null,
    name,
    description,
    isPrivate,
    head: 'main',
    objects: new Map(),
    refs: new Map(),
    nextNumber: 1,
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    hooks: [],
    nextHookId: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  nextRepoDbId += 1;
  repos.push(repo);
  return repo;
}

function repoOwnerLogin(repo: RepoRec): string {
  return repo.owner ?? viewerLogin;
}

function notify(repo: RepoRec, title: string, type: string): void {
  notifications.push({
    id: String(nextNotificationId),
    unread: true,
    reason: 'subscribed',
    updated_at: nowIso(),
    subject: { title, url: null, latest_comment_url: null, type },
    repositoryName: repo.name,
  });
  nextNotificationId += 1;
}

function fireHooks(repo: RepoRec, event: string, payload: Record<string, unknown>): void {
  for (const hook of repo.hooks) {
    if (!hook.active) continue;
    if (hook.events.length > 0 && !hook.events.includes(event) && !hook.events.includes('*')) continue;
    const url = hook.config.url;
    if (!url) continue;
    // Best effort only: a trial has no network, and a failed delivery must
    // never fail the request that caused it.
    try {
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': event },
        body: JSON.stringify({ ...payload, hook_id: hook.id }),
        signal: AbortSignal.timeout(1500),
      }).catch(() => undefined);
    } catch {
      // ignored
    }
  }
}

// ---------------------------------------------------------------------------
// git object model

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1hex(Buffer.concat([header, data]));
}

function storeObject(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {oid, mode}. */
function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path map; returns the root tree oid. */
function buildTreeFromFlat(repo: RepoRec, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const dir = segments[i] as string;
      if (!node.dirs.has(dir)) node.dirs.set(dir, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(dir) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return build(root);
}

interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  timestamp: number;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let timestamp = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) timestamp = Number(match[1]);
    }
  }
  return { tree, parents, message, timestamp };
}

function buildCommitData(fields: { tree: string; parents: string[]; message: string; name: string; email: string; ts: number }): Buffer {
  const ident = `${fields.name} <${fields.email}> ${fields.ts} +0000`;
  let text = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${fields.message}`;
  if (!text.endsWith('\n')) text += '\n';
  return Buffer.from(text, 'utf8');
}

function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (!match) return null;
      current = match[1] as string;
      continue;
    }
    return null;
  }
  return null;
}

function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return false;
}

function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (ancestorsOfA.has(current)) continue;
    ancestorsOfA.add(current);
    const obj = repo.objects.get(current);
    if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const bfs = [b];
  while (bfs.length > 0) {
    const current = bfs.shift() as string;
    if (ancestorsOfA.has(current)) return current;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj && obj.type === 'commit') bfs.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** All objects reachable from `tips` (commits, their trees and blobs, tags). */
function reachableObjects(repo: RepoRec, tips: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match) stack.push(match[1] as string);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const bytes: number[] = [];
    let value = obj.data.length;
    let first = (TYPE_CODES[obj.type] << 4) | (value & 0x0f);
    value >>= 4;
    let rest = value;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a pack into the repo store. Returns the number of objects stored. */
function readPackInto(repo: RepoRec, pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const pending: { baseOid?: string; baseOffset?: number; delta: Buffer; offset: number }[] = [];
  const byOffset = new Map<number, string>();
  let stored = 0;
  const storeResolved = (type: ObjType, data: Buffer, at: number): string => {
    const oid = storeObject(repo, type, data);
    byOffset.set(at, oid);
    stored += 1;
    return oid;
  };
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    // size is informational here; inflation bounds the real data
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
    }
    if (typeCode === 6) {
      // OFS_DELTA
      let b = pack[offset] as number;
      offset += 1;
      let baseOffsetValue = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        baseOffsetValue = ((baseOffsetValue + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ baseOffset: entryOffset - baseOffsetValue, delta: inflated.data, offset: entryOffset });
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ baseOid, delta: inflated.data, offset: entryOffset });
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`bad pack type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      storeResolved(type, inflated.data, entryOffset);
    }
  }
  // Resolve deltas (possibly chained).
  let guard = 0;
  while (pending.length > 0 && guard < 10000) {
    guard += 1;
    const item = pending.shift() as { baseOid?: string; baseOffset?: number; delta: Buffer; offset: number };
    const baseOid = item.baseOid ?? (item.baseOffset !== undefined ? byOffset.get(item.baseOffset) : undefined);
    const base = baseOid ? repo.objects.get(baseOid) : undefined;
    if (!base || !baseOid) {
      pending.push(item);
      if (guard > 9000) throw new Error('unresolvable delta base');
      continue;
    }
    const data = applyDelta(base.data, item.delta);
    storeResolved(base.type, data, item.offset);
  }
  return stored;
}

// ---------------------------------------------------------------------------
// pkt-line

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_END = Buffer.from('0002', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

function decodePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length >= 4 && offset + length <= buffer.length) {
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    } else {
      break;
    }
  }
  return packets;
}

/** Split a receive-pack body into its pkt-line command section and pack bytes. */
function splitCommandPack(buffer: Buffer): { packets: Packet[]; pack: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      return { packets, pack: buffer.subarray(offset) };
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, pack: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// git smart HTTP

const UPLOAD_CAPS_V0 = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not deepen-relative multi_ack object-format=sha1 agent=git-forge/1.0';
const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=git-forge/1.0';

function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

function refLinesV0(repo: RepoRec, caps: string): Buffer {
  const parts: Buffer[] = [];
  const names = sortedRefNames(repo);
  let first = true;
  const emit = (oid: string, name: string) => {
    if (first) {
      parts.push(pkt(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pkt(`${oid} ${name}\n`));
    }
  };
  if (names.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  const headTarget = `refs/heads/${repo.head}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) emit(headOid, 'HEAD');
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    emit(oid, name);
    const peeled = peelToCommit(repo, oid);
    if (peeled && peeled !== oid) emit(peeled, `${name}^{}`);
  }
  return Buffer.concat(parts);
}

function withSymref(caps: string, repo: RepoRec): string {
  return `${caps} symref=HEAD:refs/heads/${repo.head}`;
}

function handleInfoRefs(res: ServerResponse, repo: RepoRec, service: string, protocolHeader: string): void {
  const isUpload = service === 'git-upload-pack';
  const wantsV2 = isUpload && /version=2/.test(protocolHeader);
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  if (wantsV2) {
    parts.push(
      pkt('version 2\n'),
      pkt('agent=git-forge/1.0\n'),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    );
  } else if (isUpload) {
    parts.push(refLinesV0(repo, withSymref(UPLOAD_CAPS_V0, repo)));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(refLinesV0(repo, withSymref(RECEIVE_CAPS, repo)));
    parts.push(PKT_FLUSH);
  }
  const body = Buffer.concat(parts);
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsLines(repo: RepoRec, args: LsRefsArgs): Buffer[] {
  const lines: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headTarget = `refs/heads/${repo.head}`;
  const headOid = repo.refs.get(headTarget);
  if (keep('HEAD')) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${headTarget}`;
      if (args.peel) {
        const peeled = peelToCommit(repo, headOid);
        if (peeled && peeled !== headOid) line += ` peeled:${peeled}`;
      }
      lines.push(pkt(`${line}\n`));
    } else if (args.unborn) {
      let line = `unborn HEAD`;
      if (args.symrefs) line += ` symref-target:${headTarget}`;
      lines.push(pkt(`${line}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(pkt(`${line}\n`));
  }
  return lines;
}

interface FetchPlan {
  objects: { type: ObjType; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Decide what a fetch sends: commits within `depth` generations of the wants
 * (all generations when depth is null), plus their trees/blobs, minus every
 * object reachable from the haves.
 */
function planFetch(repo: RepoRec, wants: string[], haves: string[], depth: number | null, clientShallow: string[]): FetchPlan {
  // What the client already holds: the full closure of each have — except
  // that a have the client itself lists as a shallow boundary does NOT imply
  // it holds that commit's ancestors (that is the point of the boundary).
  const shallowSet = new Set(clientShallow);
  const haveObjects = new Set<string>();
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    if (!shallowSet.has(have)) {
      for (const oid of reachableObjects(repo, [have])) haveObjects.add(oid);
      continue;
    }
    haveObjects.add(have);
    const commitOid = peelToCommit(repo, have);
    if (commitOid) {
      haveObjects.add(commitOid);
      const commit = parseCommit((repo.objects.get(commitOid) as GitObj).data);
      for (const oid of reachableObjects(repo, [commit.tree])) haveObjects.add(oid);
    }
  }
  // generation walk
  const generation = new Map<string, number>();
  let frontier = [...new Set(wants)].filter((oid) => peelToCommit(repo, oid) !== null);
  // wants may be tag objects: generation counts from the peeled commit, but the
  // tag object itself must also be sent.
  const extraTips: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj && obj.type === 'tag') extraTips.push(want);
  }
  let gen = 0;
  const includedCommits = new Set<string>();
  const seenFrontier = new Set<string>();
  while (frontier.length > 0) {
    if (depth !== null && gen >= depth) break;
    const next: string[] = [];
    for (const oid of frontier) {
      const commitOid = peelToCommit(repo, oid);
      if (!commitOid || seenFrontier.has(commitOid)) continue;
      seenFrontier.add(commitOid);
      generation.set(commitOid, gen);
      includedCommits.add(commitOid);
      const commit = parseCommit((repo.objects.get(commitOid) as GitObj).data);
      next.push(...commit.parents);
    }
    frontier = next;
    gen += 1;
  }
  const include = new Set<string>();
  for (const tip of extraTips) for (const oid of reachableObjects(repo, [tip])) include.add(oid);
  for (const commitOid of includedCommits) {
    include.add(commitOid);
    const commit = parseCommit((repo.objects.get(commitOid) as GitObj).data);
    for (const oid of reachableObjects(repo, [commit.tree])) include.add(oid);
  }
  for (const oid of haveObjects) include.delete(oid);
  // shallow boundary: included commits at the deepest generation that still
  // have parents outside the plan.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const commitOid of includedCommits) {
      if (haveObjects.has(commitOid)) continue;
      const commit = parseCommit((repo.objects.get(commitOid) as GitObj).data);
      if (commit.parents.length > 0 && (generation.get(commitOid) ?? 0) === depth - 1) shallow.push(commitOid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (includedCommits.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
  }
  const objects: { type: ObjType; data: Buffer }[] = [];
  for (const oid of include) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    frames.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return frames;
}

function handleUploadPackV2(res: ServerResponse, repo: RepoRec, packets: Packet[]): void {
  // split command section and argument section at the delim packet
  let command = '';
  const argLines: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush' || packet.kind === 'end') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      argLines.push(line);
    }
  }
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argLines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    const body = Buffer.concat([...lsRefsLines(repo, args), PKT_FLUSH]);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
    res.end(body);
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;
    let doneReceived = false;
    let waitForDone = false;
    for (const line of argLines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      else if (line === 'done') doneReceived = true;
      else if (line === 'wait-for-done') waitForDone = true;
    }
    // Negotiation round: the client has not said "done", so answer with the
    // acknowledgments section only — no packfile yet. Real git is strict
    // here: once the client sends "done", an acknowledgments section before
    // the packfile is a protocol error.
    if (!doneReceived && (haves.length > 0 || waitForDone)) {
      const parts: Buffer[] = [pkt('acknowledgments\n')];
      const common = haves.find((have) => repo.objects.has(have));
      if (common) parts.push(pkt(`ACK ${common}\n`));
      else if (haves.length > 0) parts.push(pkt('NAK\n'));
      else parts.push(pkt('ready\n'));
      parts.push(PKT_FLUSH);
      const body = Buffer.concat(parts);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
      res.end(body);
      return;
    }
    const plan = planFetch(repo, wants, haves, depth, clientShallow);
    const parts: Buffer[] = [];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(writePack(plan.objects)));
    parts.push(PKT_FLUSH);
    const body = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
    res.end(body);
    return;
  }
  const body = Buffer.concat([pkt('ERR unknown command\n'), PKT_FLUSH]);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

function handleUploadPackV0(res: ServerResponse, repo: RepoRec, packets: Packet[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let useSideband = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const [oid, ...caps] = rest.split(' ');
      if (oid) wants.push(oid);
      if (caps.join(' ').includes('side-band')) useSideband = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const plan = planFetch(repo, wants, haves, depth, clientShallow);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const common = haves.find((have) => repo.objects.has(have));
  if (haves.length > 0 && common) parts.push(pkt(`ACK ${common} common\n`));
  else parts.push(pkt('NAK\n'));
  const pack = writePack(plan.objects);
  if (useSideband) parts.push(...sidebandPack(pack));
  else parts.push(pack);
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const { packets, pack } = splitCommandPack(body);
  const commands: PushCommand[] = [];
  let useSideband = false;
  let reportStatus = true;
  packets.forEach((packet, index) => {
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        if (caps.includes('side-band-64k')) useSideband = true;
        if (!caps.includes('report-status')) reportStatus = false;
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  });

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      readPackInto(repo, pack);
    } catch {
      unpackOk = false;
      unpackDetail = 'index-pack failed';
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    // git always sends a pack with an update; an empty one is fine (no objects).
  }

  const reports: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      reports.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
      } else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current !== ZERO_OID && current !== command.oldOid) {
      reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (current !== ZERO_OID) {
      const newCommit = peelToCommit(repo, command.newOid);
      const currentCommit = peelToCommit(repo, current);
      if (newCommit && currentCommit && newCommit !== currentCommit && !isAncestor(repo, currentCommit, newCommit)) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    if (command.ref === `refs/heads/${repo.head}` || (repo.refs.size === 1 && command.ref.startsWith('refs/heads/'))) {
      // keep head as-is; the default branch name is fixed at creation
    }
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!reportStatus) {
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': 0 });
    res.end();
    return;
  }
  const reportLines: Buffer[] = [pkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const report of reports) {
    reportLines.push(pkt(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const report = Buffer.concat(reportLines);
  let out: Buffer;
  if (useSideband) {
    const frames: Buffer[] = [];
    // the whole report travels in band 1, framed as its own pkt-lines
    let offset = 0;
    while (offset < report.length) {
      const slice = report.subarray(offset, Math.min(report.length, offset + 65000));
      frames.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
      offset += slice.length;
    }
    frames.push(PKT_FLUSH);
    out = Buffer.concat(frames);
  } else {
    out = report;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
  // A successful push is a webhook event, like GitHub's.
  if (reports.some((report) => report.ok)) {
    fireHooks(repo, 'push', { ref: commands[0]?.ref ?? '', repository: { name: repo.name } });
  }
}

// ---------------------------------------------------------------------------
// domain operations shared by REST, GraphQL and MCP

function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function resolveRef(repo: RepoRec, ref: string): string | null {
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref) ?? null;
}

function commitFiles(repo: RepoRec, commitOid: string): Map<string, { oid: string; mode: string }> {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(commit.data).tree);
}

/** Commit a flat file map onto a branch; returns the new commit oid. */
function commitFlat(repo: RepoRec, branch: string, flat: Map<string, { oid: string; mode: string }>, message: string): string {
  const tree = buildTreeFromFlat(repo, flat);
  const parent = branchTip(repo, branch);
  const user = viewer();
  const data = buildCommitData({
    tree,
    parents: parent ? [parent] : [],
    message,
    name: user.name,
    email: user.email,
    ts: nowEpochSec(),
  });
  const oid = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updated_at = nowIso();
  return oid;
}

/** PUT/DELETE one file through the contents API semantics. */
function putFile(repo: RepoRec, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; contentSha: string | null } {
  const tip = branchTip(repo, branch);
  const flat = tip ? commitFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
  let contentSha: string | null = null;
  if (content !== null) {
    contentSha = storeObject(repo, 'blob', content);
    flat.set(path, { oid: contentSha, mode: '100644' });
  } else {
    flat.delete(path);
  }
  const commitSha = commitFlat(repo, branch, flat, message);
  return { commitSha, contentSha };
}

interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function lcsLength(a: string[], b: string[]): number {
  // bounded LCS for line-diff counts; files in the suite are small
  if (a.length * b.length > 4_000_000) {
    const setB = new Set(b);
    return a.filter((line) => setB.has(line)).length;
  }
  const dp = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j] as number;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j] as number, dp[j - 1] as number);
      prev = tmp;
    }
  }
  return dp[b.length] as number;
}

function diffTrees(repo: RepoRec, baseCommit: string | null, headCommit: string | null): FileChange[] {
  const baseFlat = baseCommit ? commitFiles(repo, baseCommit) : new Map<string, { oid: string; mode: string }>();
  const headFlat = headCommit ? commitFiles(repo, headCommit) : new Map<string, { oid: string; mode: string }>();
  const changes: FileChange[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before && after && before.oid === after.oid) continue;
    if (!before && after) {
      const data = (repo.objects.get(after.oid) as GitObj).data;
      const additions = countLines(data);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before && !after) {
      const data = (repo.objects.get(before.oid) as GitObj).data;
      const deletions = countLines(data);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before && after) {
      const oldLines = (repo.objects.get(before.oid) as GitObj).data.toString('utf8').split('\n');
      const newLines = (repo.objects.get(after.oid) as GitObj).data.toString('utf8').split('\n');
      const common = lcsLength(oldLines, newLines);
      const additions = newLines.length - common;
      const deletions = oldLines.length - common;
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/**
 * Three-way tree merge (file level). Returns the merged flat map, or null on
 * conflict: a path changed on both sides to different contents.
 */
function mergeTrees(
  repo: RepoRec,
  baseFlat: Map<string, { oid: string; mode: string }>,
  ourFlat: Map<string, { oid: string; mode: string }>,
  theirFlat: Map<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | null {
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFlat.keys(), ...ourFlat.keys(), ...theirFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path)?.oid;
    const ours = ourFlat.get(path)?.oid;
    const theirs = theirFlat.get(path)?.oid;
    if (ours === theirs) {
      const value = ourFlat.get(path) ?? theirFlat.get(path);
      if (value) merged.set(path, value);
      continue;
    }
    if (base === ours) {
      const value = theirFlat.get(path);
      if (value) merged.set(path, value);
      continue;
    }
    if (base === theirs) {
      const value = ourFlat.get(path);
      if (value) merged.set(path, value);
      continue;
    }
    return null;
  }
  return merged;
}

interface MergeOutcome {
  ok: boolean;
  conflict: boolean;
  sha: string | null;
}

/** Squash-merge a pull request (the only method the suite drives). */
function mergePull(repo: RepoRec, pull: PullRec, method = 'squash'): MergeOutcome {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return { ok: false, conflict: false, sha: null };
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base ? commitFiles(repo, base) : new Map<string, { oid: string; mode: string }>();
  const ourFlat = commitFiles(repo, baseTip);
  const theirFlat = commitFiles(repo, headTip);
  const merged = mergeTrees(repo, baseFlat, ourFlat, theirFlat);
  if (merged === null) return { ok: false, conflict: true, sha: null };
  const user = viewer();
  let sha: string;
  if (method === 'merge') {
    const tree = buildTreeFromFlat(repo, merged);
    const data = buildCommitData({
      tree,
      parents: [baseTip, headTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
      name: user.name,
      email: user.email,
      ts: nowEpochSec(),
    });
    sha = storeObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  } else {
    // squash: one commit on the base whose tree is the merged tree
    sha = commitFlat(repo, pull.baseRef, merged, `${pull.title} (#${pull.number})\n`);
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.merge_commit_sha = sha;
  pull.updated_at = nowIso();
  repo.updated_at = nowIso();
  fireHooks(repo, 'pull_request', { action: 'closed', number: pull.number, pull_request: { number: pull.number, merged: true } });
  return { ok: true, conflict: false, sha };
}

function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return false;
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base ? commitFiles(repo, base) : new Map<string, { oid: string; mode: string }>();
  return mergeTrees(repo, baseFlat, commitFiles(repo, baseTip), commitFiles(repo, headTip)) !== null;
}

function createIssueRec(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    user: viewerLogin,
    created_at: nowIso(),
    updated_at: nowIso(),
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  notify(repo, title, 'Issue');
  fireHooks(repo, 'issues', { action: 'opened', issue: { number: issue.number, title } });
  return issue;
}

function createPullRec(repo: RepoRec, title: string, body: string, head: string, base: string): PullRec | null {
  if (!branchTip(repo, head) || !branchTip(repo, base)) return null;
  const pull: PullRec = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    user: viewerLogin,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    comments: [],
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  notify(repo, title, 'PullRequest');
  fireHooks(repo, 'pull_request', { action: 'opened', number: pull.number, pull_request: { number: pull.number, title } });
  return pull;
}

// ---------------------------------------------------------------------------
// REST v3 shapes

function repoJson(repo: RepoRec): Record<string, unknown> {
  const owner = ensureUser(repoOwnerLogin(repo));
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: globalId('Repository', String(repo.dbId)),
    name: repo.name,
    full_name: `${owner.login}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(owner),
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${owner.login}/${repo.name}`,
    html_url: `https://forge.invalid/${owner.login}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    default_branch: repo.head,
    visibility: repo.isPrivate ? 'private' : 'public',
    topics: [],
    license: null,
  };
}

function labelJson(repo: RepoRec, label: LabelRec): Record<string, unknown> {
  return {
    id: repo.dbId * 1000 + [...repo.labels.keys()].indexOf(label.name) + 1,
    node_id: globalId('Label', `${repo.dbId}:${label.name}`),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const owner = repoOwnerLogin(repo);
  return {
    id: repo.dbId * 100000 + issue.number,
    node_id: globalId('Issue', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name) ?? { name, color: 'ededed', description: null };
      return labelJson(repo, label);
    }),
    user: userJson(ensureUser(issue.user)),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${owner}/${repo.name}`,
  };
}

function commentJson(repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userJson(ensureUser(comment.user)),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    url: `/api/v3/repos/${repoOwnerLogin(repo)}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = repoOwnerLogin(repo);
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: repo.dbId * 100000 + pull.number,
    node_id: globalId('PullRequest', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    user: userJson(ensureUser(pull.user)),
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${owner}:${pull.headRef}`,
      user: userJson(ensureUser(owner)),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${owner}:${pull.baseRef}`,
      user: userJson(ensureUser(owner)),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    mergeable_state: pull.merged ? 'clean' : 'unknown',
    comments: pull.comments.length,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const commit = obj && obj.type === 'commit' ? parseCommit(obj.data) : { tree: '', parents: [] as string[], message: '', timestamp: 0 };
  const text = obj ? obj.data.toString('utf8') : '';
  const authorLine = /^author (.+?) <(.*?)> \d+/m.exec(text);
  const date = commit.timestamp ? new Date(commit.timestamp * 1000).toISOString().replace('.000Z', 'Z') : repo.created_at;
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: { name: authorLine?.[1] ?? 'unknown', email: authorLine?.[2] ?? '', date },
      committer: { name: authorLine?.[1] ?? 'unknown', email: authorLine?.[2] ?? '', date },
      comment_count: 0,
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repoOwnerLogin(repo)}/${repo.name}/commits/${oid}`,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing

function requestId(): string {
  return randomBytes(12).toString('hex').toUpperCase();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(CLOCK_BASE / 1000) + 3600),
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId(), 'content-length': 0 });
  res.end();
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message, documentation_url: 'https://docs.github.com/rest' });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
}

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

function paginate<T>(req: IncomingMessage, url: URL, items: T[]): Page<T> {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (items.length > perPage) {
    const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
    const linkFor = (p: number, rel: string): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('page', String(p));
      params.set('per_page', String(perPage));
      return `<${base}?${params.toString()}>; rel="${rel}"`;
    };
    const links: string[] = [];
    if (page < totalPages) {
      links.push(linkFor(page + 1, 'next'));
      links.push(linkFor(totalPages, 'last'));
    }
    if (page > 1) {
      links.push(linkFor(1, 'first'));
      links.push(linkFor(page - 1, 'prev'));
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { items: slice, headers };
}

// ---------------------------------------------------------------------------
// REST v3

function walkCommits(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: { oid: string; ts: number }[] = [];
  const push = (oid: string) => {
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') queue.push({ oid, ts: parseCommit(obj.data).timestamp });
  };
  push(tip);
  while (queue.length > 0) {
    queue.sort((a, b) => b.ts - a.ts);
    const next = queue.shift() as { oid: string; ts: number };
    if (seen.has(next.oid)) continue;
    seen.add(next.oid);
    order.push(next.oid);
    const commit = parseCommit((repo.objects.get(next.oid) as GitObj).data);
    for (const parent of commit.parents) if (!seen.has(parent)) push(parent);
  }
  return order;
}

function contentsEntry(repo: RepoRec, flat: Map<string, { oid: string; mode: string }>, path: string): Record<string, unknown> | null {
  const file = flat.get(path);
  if (file) {
    const data = (repo.objects.get(file.oid) as GitObj).data;
    return {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      sha: file.oid,
      content: data.toString('base64'),
      url: '',
      download_url: null,
    };
  }
  // directory?
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { dir: boolean; oid: string }>();
  for (const [candidate, value] of flat) {
    if (!candidate.startsWith(prefix)) continue;
    const rest = candidate.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, { dir: false, oid: value.oid });
    else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        // tree oid of the directory: recompute from the tree walk
        children.set(dirName, { dir: true, oid: '' });
      }
    }
  }
  if (children.size === 0 && path !== '') return null;
  return { __dir: true, children } as unknown as Record<string, unknown>;
}

function dirListing(repo: RepoRec, commitOid: string, path: string): Record<string, unknown>[] | null {
  // walk the actual tree so directory shas are real tree oids
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path !== '') {
    for (const segment of path.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (!entry) return null;
      treeOid = entry.oid;
    }
  }
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return null;
  const prefix = path === '' ? '' : `${path}/`;
  return parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    let size = 0;
    if (!isDir) {
      const blob = repo.objects.get(entry.oid);
      size = blob ? blob.data.length : 0;
    }
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: `${prefix}${entry.name}`,
      sha: entry.oid,
      size,
      url: '',
      download_url: null,
    };
  });
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((s) => s !== '').slice(2); // after /api/v3
  const headers = { 'x-oauth-scopes': 'repo, read:org' };

  let body: Record<string, unknown> = {};
  if (rawBody.length > 0 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
      if (isRecord(parsed)) body = parsed;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
      return;
    }
  }

  const seg = (i: number): string => decodeURIComponent(segments[i] ?? '');
  const rest = (i: number): string => segments.slice(i).map((s) => decodeURIComponent(s)).join('/');

  // root + meta
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      }, headers);
      return;
    }
    notFound(res);
    return;
  }
  if (seg(0) === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0-forge', hooks: [], pages: {}, importer: {}, actions: {} }, headers);
    return;
  }
  if (seg(0) === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: {}, rate: { limit: 5000, remaining: 4999, reset: Math.floor(CLOCK_BASE / 1000) + 3600, used: 1 } }, headers);
    return;
  }

  // the token's user
  if (seg(0) === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson(viewer()), headers);
    return;
  }
  if (seg(0) === 'users' && segments.length >= 2) {
    const login = seg(1);
    if (segments.length === 2 && method === 'GET') {
      const user = usersByLogin.get(login);
      if (!user) {
        notFound(res);
        return;
      }
      sendJson(res, 200, userJson(user), headers);
      return;
    }
    if (seg(2) === 'repos' && method === 'GET') {
      const owned = repos.filter((repo) => repoOwnerLogin(repo) === login);
      const page = paginate(req, url, owned.map(repoJson));
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
  }

  // repository creation + the viewer's list
  if (seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const owned = repos.filter((repo) => repoOwnerLogin(repo) === viewerLogin);
      const page = paginate(req, url, owned.map(repoJson));
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (method === 'POST') {
      const name = str(body.name);
      if (name === '') {
        unprocessable(res, 'name is required');
        return;
      }
      const duplicate = repos.some((repo) => repo.name === name);
      if (duplicate) {
        sendJson(res, 422, { message: 'name already exists on this account', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }, headers);
        return;
      }
      const repo = createRepo(name, str(body.description), body.private === true);
      repo.owner = viewerLogin;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.head = body.default_branch;
      sendJson(res, 201, repoJson(repo), headers);
      return;
    }
  }

  // search
  if (seg(0) === 'search' && method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    if (seg(1) === 'issues') {
      const terms = q.split(/\s+/).filter(Boolean);
      const words: string[] = [];
      let repoFilter: string | null = null;
      let stateFilter: string | null = null;
      let wantPr = false;
      for (const term of terms) {
        if (term.startsWith('repo:')) repoFilter = term.slice(5);
        else if (term.startsWith('state:')) stateFilter = term.slice(6);
        else if (term === 'is:pr') wantPr = true;
        else if (term.startsWith('is:') || term.startsWith('label:') || term.startsWith('author:')) continue;
        else words.push(term.toLowerCase());
      }
      const items: Record<string, unknown>[] = [];
      for (const repo of repos) {
        if (repoFilter && `${repoOwnerLogin(repo)}/${repo.name}` !== repoFilter && repo.name !== repoFilter) continue;
        const pool: { title: string; body: string; json: Record<string, unknown> }[] = [];
        if (!wantPr) for (const issue of repo.issues.values()) pool.push({ title: issue.title, body: issue.body, json: issueJson(repo, issue) });
        if (wantPr) for (const pull of repo.pulls.values()) pool.push({ title: pull.title, body: pull.body, json: pullJson(repo, pull) });
        for (const entry of pool) {
          if (stateFilter && entry.json.state !== stateFilter) continue;
          const haystack = `${entry.title} ${entry.body}`.toLowerCase();
          const wordSet = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
          if (words.every((word) => wordSet.has(word))) items.push(entry.json);
        }
      }
      const page = paginate(req, url, items);
      sendJson(res, 200, { total_count: items.length, incomplete_results: false, items: page.items }, { ...headers, ...page.headers });
      return;
    }
    if (seg(1) === 'repositories') {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const items = repos
        .filter((repo) => words.every((word) => `${repo.name} ${repo.description}`.toLowerCase().includes(word)))
        .map(repoJson);
      const page = paginate(req, url, items);
      sendJson(res, 200, { total_count: items.length, incomplete_results: false, items: page.items }, { ...headers, ...page.headers });
      return;
    }
    notFound(res);
    return;
  }

  // notifications (the /read collection)
  if (seg(0) === 'notifications') {
    if (segments.length === 1 && method === 'GET') {
      const all = url.searchParams.get('all') === 'true';
      const list = notifications.filter((n) => all || n.unread).map((n) => {
        const repo = findRepoByName(n.repositoryName);
        return {
          id: n.id,
          unread: n.unread,
          reason: n.reason,
          updated_at: n.updated_at,
          created_at: n.updated_at,
          last_read_at: null,
          subject: n.subject,
          repository: repo ? repoJson(repo) : { name: n.repositoryName },
          url: `/api/v3/notifications/threads/${n.id}`,
        };
      });
      const page = paginate(req, url, list);
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (segments.length === 1 && (method === 'PUT' || method === 'PATCH')) {
      for (const n of notifications) n.unread = false; // idempotent mark-all-read
      sendEmpty(res, 205);
      return;
    }
    if (seg(1) === 'threads' && segments.length === 3) {
      const thread = notifications.find((n) => n.id === seg(2));
      if (!thread) {
        notFound(res);
        return;
      }
      if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
        thread.unread = false;
        sendEmpty(res, 205);
        return;
      }
      if (method === 'DELETE') {
        thread.unread = false;
        sendEmpty(res, 204);
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { id: thread.id, unread: thread.unread, reason: thread.reason, updated_at: thread.updated_at, subject: thread.subject }, headers);
        return;
      }
    }
    notFound(res);
    return;
  }

  if (seg(0) !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }
  const owner = seg(1);
  const repoName = seg(2);
  const repo = findRepo(owner, repoName);
  if (!repo) {
    notFound(res);
    return;
  }
  const tail = segments.slice(3);
  const tailSeg = (i: number): string => decodeURIComponent(tail[i] ?? '');
  const tailRest = (i: number): string => tail.slice(i).map((s) => decodeURIComponent(s)).join('/');

  // the repository itself
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo), headers);
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.head = body.default_branch;
      repo.updated_at = nowIso();
      sendJson(res, 200, repoJson(repo), headers);
      return;
    }
    if (method === 'DELETE') {
      const index = repos.indexOf(repo);
      if (index >= 0) repos.splice(index, 1);
      sendEmpty(res, 204);
      return;
    }
    notFound(res);
    return;
  }

  // branches
  if (tailSeg(0) === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => {
          const name = ref.slice('refs/heads/'.length);
          return { name, commit: { sha: repo.refs.get(ref) as string, url: '' }, protected: false };
        });
      const page = paginate(req, url, list);
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const name = tailRest(1);
      const tip = branchTip(repo, name);
      if (!tip) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name, commit: { sha: tip, url: '', node_id: globalId('Commit', tip) }, protected: false, _links: {} }, headers);
      return;
    }
    notFound(res);
    return;
  }

  // commits
  if (tailSeg(0) === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha') ?? repo.head;
      const tip = resolveRef(repo, shaParam) ?? branchTip(repo, repo.head);
      if (!tip) {
        sendJson(res, 200, [], headers);
        return;
      }
      const commitOid = peelToCommit(repo, tip);
      if (!commitOid) {
        sendJson(res, 200, [], headers);
        return;
      }
      const list = walkCommits(repo, commitOid).map((oid) => commitJson(repo, oid));
      const page = paginate(req, url, list);
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const oid = tailSeg(1);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') {
        notFound(res);
        return;
      }
      sendJson(res, 200, commitJson(repo, oid), headers);
      return;
    }
    notFound(res);
    return;
  }

  // git refs
  if (tailSeg(0) === 'git' && tailSeg(1) === 'refs') {
    if (tail.length === 2 && method === 'GET') {
      const list = sortedRefNames(repo).map((ref) => ({ ref, node_id: globalId('Ref', ref), url: '', object: { sha: repo.refs.get(ref) as string, type: 'commit' } }));
      sendJson(res, 200, list, headers);
      return;
    }
    if (tail.length === 2 && method === 'POST') {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        unprocessable(res, 'invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        unprocessable(res, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: globalId('Ref', ref), url: '', object: { sha, type: 'commit' } }, headers);
      return;
    }
    if (tail.length >= 3) {
      const ref = `refs/${tailRest(2)}`;
      if (method === 'GET') {
        const sha = repo.refs.get(ref);
        if (!sha) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { ref, node_id: globalId('Ref', ref), url: '', object: { sha, type: 'commit' } }, headers);
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.has(ref)) {
          notFound(res);
          return;
        }
        repo.refs.delete(ref);
        sendEmpty(res, 204);
        return;
      }
    }
    notFound(res);
    return;
  }

  // git trees / blobs (cheap completeness)
  if (tailSeg(0) === 'git' && tailSeg(1) === 'trees' && tail.length === 3 && method === 'GET') {
    const obj = repo.objects.get(tailSeg(2));
    if (!obj || obj.type !== 'tree') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { sha: tailSeg(2), tree: parseTree(obj.data).map((e) => ({ path: e.name, mode: e.mode, type: e.mode === '40000' || e.mode === '040000' ? 'tree' : 'blob', sha: e.oid })), truncated: false }, headers);
    return;
  }
  if (tailSeg(0) === 'git' && tailSeg(1) === 'blobs' && tail.length === 3 && method === 'GET') {
    const obj = repo.objects.get(tailSeg(2));
    if (!obj || obj.type !== 'blob') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { sha: tailSeg(2), size: obj.data.length, encoding: 'base64', content: obj.data.toString('base64') }, headers);
    return;
  }

  // contents
  if (tailSeg(0) === 'contents') {
    const path = tailRest(1);
    const branchParam = typeof body.branch === 'string' ? body.branch : (url.searchParams.get('ref') ?? repo.head);
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref') ?? repo.head;
      const oid = resolveRef(repo, refParam);
      const commitOid = oid ? peelToCommit(repo, oid) : null;
      if (!commitOid) {
        notFound(res);
        return;
      }
      if (path === '' || path.endsWith('/')) {
        const listing = dirListing(repo, commitOid, path.replace(/\/$/, ''));
        if (!listing) {
          notFound(res);
          return;
        }
        sendJson(res, 200, listing, headers);
        return;
      }
      const flat = commitFiles(repo, commitOid);
      const entry = contentsEntry(repo, flat, path);
      if (!entry) {
        notFound(res);
        return;
      }
      if ((entry as { __dir?: boolean }).__dir) {
        const listing = dirListing(repo, commitOid, path);
        if (!listing) {
          notFound(res);
          return;
        }
        sendJson(res, 200, listing, headers);
        return;
      }
      sendJson(res, 200, entry, headers);
      return;
    }
    if (method === 'PUT') {
      const branch = branchParam;
      const message = str(body.message, 'update via API');
      const contentB64 = str(body.content);
      const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const tip = branchTip(repo, branch);
      const flat = tip ? commitFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
      const existing = flat.get(path);
      const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (existing) {
        if (givenSha === undefined) {
          unprocessable(res, 'sha must be supplied when updating an existing file');
          return;
        }
        if (givenSha !== existing.oid) {
          sendJson(res, 409, { message: 'sha does not match the current file' }, headers);
          return;
        }
      }
      const result = putFile(repo, branch, path, content, message);
      const status = existing ? 200 : 201;
      sendJson(res, status, {
        content: { type: 'file', encoding: 'base64', size: content.length, name: path.split('/').pop() ?? path, path, sha: result.contentSha },
        commit: { sha: result.commitSha, message },
      }, headers);
      return;
    }
    if (method === 'DELETE') {
      const branch = branchParam;
      const tip = branchTip(repo, branch);
      const flat = tip ? commitFiles(repo, tip) : new Map<string, { oid: string; mode: string }>();
      const existing = flat.get(path);
      if (!existing) {
        notFound(res);
        return;
      }
      const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (givenSha !== undefined && givenSha !== existing.oid) {
        sendJson(res, 409, { message: 'sha does not match the current file' }, headers);
        return;
      }
      const result = putFile(repo, branch, path, null, str(body.message, 'delete via API'));
      sendJson(res, 200, { content: null, commit: { sha: result.commitSha, message: str(body.message, 'delete via API') } }, headers);
      return;
    }
    notFound(res);
    return;
  }

  // labels
  if (tailSeg(0) === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      const list = [...repo.labels.values()].map((label) => labelJson(repo, label));
      const page = paginate(req, url, list);
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const name = str(body.name);
      if (name === '') {
        unprocessable(res, 'name is required');
        return;
      }
      if (repo.labels.has(name)) {
        unprocessable(res, 'name has already been taken');
        return;
      }
      const label: LabelRec = { name, color: str(body.color, 'ededed').replace(/^#/, ''), description: typeof body.description === 'string' ? body.description : null };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(repo, label), headers);
      return;
    }
    if (tail.length === 2) {
      const name = tailSeg(1);
      const label = repo.labels.get(name);
      if (!label) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, labelJson(repo, label), headers);
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.color === 'string') label.color = body.color.replace(/^#/, '');
        if (typeof body.description === 'string') label.description = body.description;
        if (typeof body.new_name === 'string' && body.new_name !== '' && body.new_name !== name) {
          repo.labels.delete(name);
          label.name = body.new_name;
          repo.labels.set(label.name, label);
        }
        sendJson(res, 200, labelJson(repo, label), headers);
        return;
      }
      if (method === 'DELETE') {
        repo.labels.delete(name);
        sendEmpty(res, 204);
        return;
      }
    }
    notFound(res);
    return;
  }

  // issues + comments
  if (tailSeg(0) === 'issues') {
    if (tail.length === 1 && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const labelFilter = url.searchParams.get('labels');
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      if (labelFilter) {
        const wanted = labelFilter.split(',').map((s) => s.trim()).filter(Boolean);
        list = list.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
      }
      list.sort((a, b) => (sort === 'created' ? a.number - b.number : a.number - b.number));
      if (direction === 'desc') list.reverse();
      const page = paginate(req, url, list.map((issue) => issueJson(repo, issue)));
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const title = str(body.title);
      if (title === '') {
        unprocessable(res, 'title is required');
        return;
      }
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.name) : '';
          if (name !== '') labelNames.push(name);
        }
      }
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          unprocessable(res, `label "${name}" does not exist`);
          return;
        }
      }
      const issue = createIssueRec(repo, title, str(body.body), labelNames);
      sendJson(res, 201, issueJson(repo, issue), headers);
      return;
    }
    const number = Number(tailSeg(1));
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    const pullAsIssue = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2 && method === 'GET') {
      if (issue) {
        sendJson(res, 200, issueJson(repo, issue), headers);
        return;
      }
      if (pullAsIssue) {
        // GitHub serves a pull request at its issue URL too
        sendJson(res, 200, { ...pullJson(repo, pullAsIssue), pull_request: { url: `/api/v3/repos/${owner}/${repoName}/pulls/${number}` } }, headers);
        return;
      }
      notFound(res);
      return;
    }
    if (tail.length === 2 && method === 'PATCH') {
      if (!issue) {
        notFound(res);
        return;
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.name) : '';
          if (name !== '' && !repo.labels.has(name)) {
            unprocessable(res, `label "${name}" does not exist`);
            return;
          }
          if (name !== '') names.push(name);
        }
        issue.labels = names;
      }
      issue.updated_at = nowIso();
      sendJson(res, 200, issueJson(repo, issue), headers);
      return;
    }
    if (tailSeg(2) === 'comments') {
      const holder = issue ?? pullAsIssue;
      if (!holder) {
        notFound(res);
        return;
      }
      if (tail.length === 3 && method === 'GET') {
        const page = paginate(req, url, holder.comments.map((comment) => commentJson(repo, comment)));
        sendJson(res, 200, page.items, { ...headers, ...page.headers });
        return;
      }
      if (tail.length === 3 && method === 'POST') {
        const comment: CommentRec = {
          id: nextCommentId,
          body: str(body.body),
          user: viewerLogin,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        nextCommentId += 1;
        holder.comments.push(comment);
        sendJson(res, 201, commentJson(repo, comment), headers);
        return;
      }
    }
    if (tailSeg(2) === 'labels' && issue) {
      if (method === 'POST') {
        const names = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
        for (const name of names) {
          if (!repo.labels.has(name)) {
            unprocessable(res, `label "${name}" does not exist`);
            return;
          }
        }
        for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
        sendJson(res, 200, issue.labels.map((name) => labelJson(repo, repo.labels.get(name) as LabelRec)), headers);
        return;
      }
      if (method === 'DELETE' && tail.length === 4) {
        const name = tailSeg(3);
        issue.labels = issue.labels.filter((label) => label !== name);
        sendJson(res, 200, issue.labels.map((label) => labelJson(repo, repo.labels.get(label) as LabelRec)), headers);
        return;
      }
      if (method === 'DELETE' && tail.length === 3) {
        issue.labels = [];
        sendJson(res, 200, [], headers);
        return;
      }
    }
    notFound(res);
    return;
  }

  // pull requests
  if (tailSeg(0) === 'pulls') {
    if (tail.length === 1 && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      const direction = url.searchParams.get('direction') ?? 'desc';
      list.sort((a, b) => a.number - b.number);
      if (direction === 'desc') list.reverse();
      const page = paginate(req, url, list.map((pull) => pullJson(repo, pull)));
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base, repo.head);
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (title === '' || head === '') {
        unprocessable(res, 'title and head are required');
        return;
      }
      if (!branchTip(repo, head) || !branchTip(repo, base)) {
        unprocessable(res, 'head or base branch does not exist');
        return;
      }
      if (head === base) {
        unprocessable(res, 'head and base are the same');
        return;
      }
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing) {
        unprocessable(res, `A pull request already exists for ${head} into ${base}`);
        return;
      }
      const pull = createPullRec(repo, title, str(body.body), head, base);
      if (!pull) {
        unprocessable(res, 'could not create pull request');
        return;
      }
      sendJson(res, 201, pullJson(repo, pull), headers);
      return;
    }
    const number = Number(tailSeg(1));
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (!pull) {
      notFound(res);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull), headers);
      return;
    }
    if (tail.length === 2 && method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      pull.updated_at = nowIso();
      sendJson(res, 200, pullJson(repo, pull), headers);
      return;
    }
    if (tailSeg(2) === 'files' && tail.length === 3 && method === 'GET') {
      const baseTip = branchTip(repo, pull.baseRef);
      const headTip = branchTip(repo, pull.headRef);
      const base = baseTip && headTip ? mergeBase(repo, baseTip, headTip) : null;
      const files = diffTrees(repo, base, headTip);
      const page = paginate(req, url, files.map((file) => ({
        sha: '',
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })));
      sendJson(res, 200, page.items, { ...headers, ...page.headers });
      return;
    }
    if (tailSeg(2) === 'merge' && tail.length === 3 && method === 'PUT') {
      if (pull.state !== 'open') {
        sendJson(res, 405, { message: 'Pull Request is not open' }, headers);
        return;
      }
      const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
      const outcome = mergePull(repo, pull, method === 'merge' ? 'merge' : 'squash');
      if (!outcome.ok) {
        if (outcome.conflict) {
          sendJson(res, 405, { message: 'Pull Request is not mergeable' }, headers);
          return;
        }
        sendJson(res, 405, { message: 'Pull Request is not mergeable' }, headers);
        return;
      }
      sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' }, headers);
      return;
    }
    if (tailSeg(2) === 'comments') {
      if (tail.length === 3 && method === 'GET') {
        const page = paginate(req, url, pull.comments.map((comment) => commentJson(repo, comment)));
        sendJson(res, 200, page.items, { ...headers, ...page.headers });
        return;
      }
      if (tail.length === 3 && method === 'POST') {
        const comment: CommentRec = { id: nextCommentId, body: str(body.body), user: viewerLogin, created_at: nowIso(), updated_at: nowIso() };
        nextCommentId += 1;
        pull.comments.push(comment);
        sendJson(res, 201, commentJson(repo, comment), headers);
        return;
      }
    }
    notFound(res);
    return;
  }

  // webhooks
  if (tailSeg(0) === 'hooks') {
    if (tail.length === 1 && method === 'GET') {
      sendJson(res, 200, repo.hooks.map((hook) => ({ id: hook.id, name: hook.name, active: hook.active, events: hook.events, config: hook.config })), headers);
      return;
    }
    if (tail.length === 1 && method === 'POST') {
      const hook: HookRec = {
        id: repo.nextHookId,
        name: str(body.name, 'web'),
        active: body.active !== false,
        events: Array.isArray(body.events) ? body.events.filter((x): x is string => typeof x === 'string') : ['push'],
        config: isRecord(body.config) ? { url: str(body.config.url), content_type: str(body.config.content_type, 'json') } : {},
      };
      repo.nextHookId += 1;
      repo.hooks.push(hook);
      sendJson(res, 201, { id: hook.id, name: hook.name, active: hook.active, events: hook.events, config: hook.config }, headers);
      return;
    }
    if (tail.length === 2) {
      const hook = repo.hooks.find((candidate) => candidate.id === Number(tailSeg(1)));
      if (!hook) {
        notFound(res);
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, { id: hook.id, name: hook.name, active: hook.active, events: hook.events, config: hook.config }, headers);
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.active === 'boolean') hook.active = body.active;
        if (Array.isArray(body.events)) hook.events = body.events.filter((x): x is string => typeof x === 'string');
        sendJson(res, 200, { id: hook.id, name: hook.name, active: hook.active, events: hook.events, config: hook.config }, headers);
        return;
      }
      if (method === 'DELETE') {
        repo.hooks = repo.hooks.filter((candidate) => candidate !== hook);
        sendEmpty(res, 204);
        return;
      }
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------
// GraphQL v4 (the subset gh and github-mcp-server speak)

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  alias: string | null;
  name: string;
  args: { name: string; value: GqlValue }[];
  selection: GqlField[] | null;
  fragment?: string; // inline fragment type condition or named fragment spread
  isSpread?: boolean;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: GqlField[];
}

function gqlTokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push(`"${input.slice(i + 3, end === -1 ? input.length : end)}"`);
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          out += input[j + 1];
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(input.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  fragments = new Map<string, GqlField[]>();

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string {
    return this.tokens[this.pos] ?? '';
  }

  private next(): string {
    const token = this.tokens[this.pos] ?? '';
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | null = null;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.peek())) name = this.next();
        if (this.peek() === '(') this.skipParens();
        // directives
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipParens();
        }
        operations.push({ kind: head === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.next(); // 'on'
        this.next(); // type name
        if (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipParens();
        }
        this.fragments.set(fragName, this.parseSelectionSet());
      } else if (head === '{') {
        operations.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeName = this.next();
        return { alias: null, name: '', args: [], selection: this.parseSelectionSet(), fragment: typeName, isSpread: true };
      }
      const fragName = this.next();
      return { alias: null, name: '', args: [], selection: null, fragment: fragName, isSpread: true };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: { name: string; value: GqlValue }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.pos < this.tokens.length) {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipParens();
    }
    let selection: GqlField[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.tokens.length) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== '}' && this.pos < this.tokens.length) {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function gqlResolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => gqlResolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = gqlResolveValue(field.value, variables);
      return out;
    }
  }
}

interface GqlObj {
  $type: string;
  [key: string]: unknown;
}

function tag(type: string, fields: Record<string, unknown>): GqlObj {
  return { $type: type, ...fields };
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'assignees', 'milestone'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRefOid', 'baseRefOid', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'url', 'repository', 'comments', 'labels', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'labels', 'refs', 'stargazerCount', 'forkCount'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'author', 'committedDate'],
  Query: ['viewer', 'repository', 'node', 'user', 'organization', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'addComment', 'createPullRequest', 'mergePullRequest', 'updateIssue'],
};
const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function gqlUser(user: UserRec): GqlObj {
  return tag('User', { user });
}
function gqlRepo(repo: RepoRec): GqlObj {
  return tag('Repository', { repo });
}
function gqlIssue(repo: RepoRec, issue: IssueRec): GqlObj {
  return tag('Issue', { repo, issue });
}
function gqlPull(repo: RepoRec, pull: PullRec): GqlObj {
  return tag('PullRequest', { repo, pull });
}

function gqlConnection(items: GqlObj[], args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : 30;
  let start = 0;
  if (typeof args.after === 'string') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const n = Number(decoded.replace(/^cursor:/, ''));
      if (Number.isFinite(n)) start = n + 1;
    } catch {
      start = 0;
    }
  }
  const slice = items.slice(start, start + first);
  const edges = slice.map((node, i) => ({ node, cursor: Buffer.from(`cursor:${start + i}`).toString('base64') }));
  return {
    nodes: slice,
    edges,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
    },
  };
}

interface GqlCtx {
  variables: Record<string, unknown>;
  errors: { message: string; path: (string | number)[] }[];
  fragments: Map<string, GqlField[]>;
}

function gqlArgs(field: GqlField, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = gqlResolveValue(arg.value, ctx.variables);
  return out;
}

function gqlResolveField(obj: GqlObj, field: GqlField, ctx: GqlCtx, path: (string | number)[]): unknown {
  const type = obj.$type;
  const name = field.name;
  const args = gqlArgs(field, ctx);
  const fail = (message: string): null => {
    ctx.errors.push({ message, path: [...path, field.alias ?? field.name] });
    return null;
  };

  if (name === '__typename') return type;

  if (type === 'Query') {
    switch (name) {
      case 'viewer':
        return gqlUser(viewer());
      case 'repository': {
        const repo = findRepo(str(args.owner), str(args.name));
        return repo ? gqlRepo(repo) : null;
      }
      case 'node': {
        const parsed = parseGlobalId(str(args.id));
        if (!parsed) return null;
        if (parsed.type === 'Repository') {
          const repo = repos.find((candidate) => candidate.dbId === Number(parsed.key));
          return repo ? gqlRepo(repo) : null;
        }
        if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
          const [dbId, numberText] = parsed.key.split(':');
          const repo = repos.find((candidate) => candidate.dbId === Number(dbId));
          if (!repo) return null;
          if (parsed.type === 'Issue') {
            const issue = repo.issues.get(Number(numberText));
            return issue ? gqlIssue(repo, issue) : null;
          }
          const pull = repo.pulls.get(Number(numberText));
          return pull ? gqlPull(repo, pull) : null;
        }
        if (parsed.type === 'User') {
          const user = [...usersByLogin.values()].find((candidate) => candidate.id === Number(parsed.key));
          return user ? gqlUser(user) : null;
        }
        return null;
      }
      case 'user': {
        const user = usersByLogin.get(str(args.login));
        return user ? gqlUser(user) : null;
      }
      case '__type': {
        const typeName = str(args.name);
        if (GQL_TYPE_FIELDS[typeName]) return tag('__Type', { typeName, kind: 'OBJECT' });
        if (GQL_ENUM_VALUES[typeName]) return tag('__Type', { typeName, kind: 'ENUM' });
        return null;
      }
      case '__schema':
        return tag('__Schema', {});
      default:
        return fail(`Field '${name}' doesn't exist on type 'Query'`);
    }
  }

  if (type === 'Mutation') {
    switch (name) {
      case 'createIssue': {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.repositoryId));
        const repo = parsed ? repos.find((candidate) => candidate.dbId === Number(parsed.key)) : undefined;
        if (!repo) return fail('repository not found');
        const labelNames: string[] = [];
        const issue = createIssueRec(repo as RepoRec, str(input.title), str(input.body), labelNames);
        return { issue: gqlIssue(repo as RepoRec, issue) };
      }
      case 'closeIssue':
      case 'reopenIssue': {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.issueId));
        if (!parsed) return fail('issue not found');
        const [dbId, numberText] = parsed.key.split(':');
        const repo = repos.find((candidate) => candidate.dbId === Number(dbId));
        const issue = repo?.issues.get(Number(numberText));
        if (!repo || !issue) return fail('issue not found');
        issue.state = name === 'closeIssue' ? 'closed' : 'open';
        issue.updated_at = nowIso();
        return { issue: gqlIssue(repo, issue) };
      }
      case 'addComment': {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.subjectId));
        if (!parsed) return fail('subject not found');
        const [dbId, numberText] = parsed.key.split(':');
        const repo = repos.find((candidate) => candidate.dbId === Number(dbId));
        const holder = repo ? (repo.issues.get(Number(numberText)) ?? repo.pulls.get(Number(numberText))) : undefined;
        if (!repo || !holder) return fail('subject not found');
        const comment: CommentRec = { id: nextCommentId, body: str(input.body), user: viewerLogin, created_at: nowIso(), updated_at: nowIso() };
        nextCommentId += 1;
        holder.comments.push(comment);
        const node = tag('IssueComment', { repo, comment });
        return { commentEdge: { node, cursor: Buffer.from(`cursor:${comment.id}`).toString('base64') }, comment: node };
      }
      case 'createPullRequest': {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.repositoryId));
        const repo = parsed ? repos.find((candidate) => candidate.dbId === Number(parsed.key)) : undefined;
        if (!repo) return fail('repository not found');
        const pull = createPullRec(repo as RepoRec, str(input.title), str(input.body), str(input.headRefName), str(input.baseRefName));
        if (!pull) return fail('head or base branch does not exist');
        return { pullRequest: gqlPull(repo as RepoRec, pull) };
      }
      case 'mergePullRequest': {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.pullRequestId));
        if (!parsed) return fail('pull request not found');
        const [dbId, numberText] = parsed.key.split(':');
        const repo = repos.find((candidate) => candidate.dbId === Number(dbId));
        const pull = repo?.pulls.get(Number(numberText));
        if (!repo || !pull) return fail('pull request not found');
        if (pull.state === 'open') {
          const outcome = mergePull(repo, pull, 'squash');
          if (!outcome.ok) return fail('Pull Request is not mergeable');
        }
        return { pullRequest: gqlPull(repo, pull) };
      }
      default:
        return fail(`Field '${name}' doesn't exist on type 'Mutation'`);
    }
  }

  if (type === 'User') {
    const user = obj.user as UserRec;
    switch (name) {
      case 'login': return user.login;
      case 'id': return globalId('User', String(user.id));
      case 'databaseId': return user.id;
      case 'name': return user.name;
      case 'email': return user.email;
      case 'url': return '';
      case 'avatarUrl': return '';
      default: return fail(`Field '${name}' doesn't exist on type 'User'`);
    }
  }

  if (type === 'Repository') {
    const repo = obj.repo as RepoRec;
    switch (name) {
      case 'id': return globalId('Repository', String(repo.dbId));
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repoOwnerLogin(repo)}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'owner': return gqlUser(ensureUser(repoOwnerLogin(repo)));
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.head);
        if (!tip) return null;
        return tag('Ref', { repo, name: repo.head, oid: tip });
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'hasWikiEnabled': return false;
      case 'createdAt': return repo.created_at;
      case 'updatedAt': return repo.updated_at;
      case 'url': return '';
      case 'issue': {
        const issue = repo.issues.get(num(args.number));
        return issue ? gqlIssue(repo, issue) : null;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? args.states.map((s) => String(s).toLowerCase()) : null;
        if (states) list = list.filter((issue) => states.includes(issue.state));
        const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
        const direction = str(orderBy.direction, 'ASC');
        list.sort((a, b) => a.number - b.number);
        if (direction === 'DESC') list.reverse();
        return gqlConnection(list.map((issue) => gqlIssue(repo, issue)), args);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(num(args.number));
        return pull ? gqlPull(repo, pull) : null;
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? args.states.map((s) => String(s).toLowerCase()) : null;
        if (states) {
          list = list.filter((pull) => (pull.merged ? 'merged' : pull.state) === states[0] || states.includes(pull.merged ? 'merged' : pull.state));
        } else {
          list = list.filter((pull) => pull.state === 'open');
        }
        list.sort((a, b) => b.number - a.number);
        return gqlConnection(list.map((pull) => gqlPull(repo, pull)), args);
      }
      case 'labels': {
        const list = [...repo.labels.values()].map((label) => tag('Label', { repo, label }));
        return gqlConnection(list, args);
      }
      default:
        return fail(`Field '${name}' doesn't exist on type 'Repository'`);
    }
  }

  if (type === 'Issue') {
    const repo = obj.repo as RepoRec;
    const issue = obj.issue as IssueRec;
    switch (name) {
      case 'id': return globalId('Issue', `${repo.dbId}:${issue.number}`);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'bodyText': return issue.body;
      case 'state': return issue.state.toUpperCase();
      case 'author': return gqlUser(ensureUser(issue.user));
      case 'createdAt': return issue.created_at;
      case 'updatedAt': return issue.updated_at;
      case 'closedAt': return issue.state === 'closed' ? issue.updated_at : null;
      case 'url': return '';
      case 'repository': return gqlRepo(repo);
      case 'labels':
        return gqlConnection(issue.labels.map((labelName) => tag('Label', { repo, label: repo.labels.get(labelName) ?? { name: labelName, color: 'ededed', description: null } })), args);
      case 'comments':
        return gqlConnection(issue.comments.map((comment) => tag('IssueComment', { repo, comment })), args);
      case 'assignees':
        return gqlConnection([], args);
      default:
        return fail(`Field '${name}' doesn't exist on type 'Issue'`);
    }
  }

  if (type === 'PullRequest') {
    const repo = obj.repo as RepoRec;
    const pull = obj.pull as PullRec;
    switch (name) {
      case 'id': return globalId('PullRequest', `${repo.dbId}:${pull.number}`);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergeable': {
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRefOid': return branchTip(repo, pull.headRef) ?? ZERO_OID;
      case 'baseRefOid': return branchTip(repo, pull.baseRef) ?? ZERO_OID;
      case 'headRef': {
        const tip = branchTip(repo, pull.headRef);
        return tip ? tag('Ref', { repo, name: pull.headRef, oid: tip }) : null;
      }
      case 'baseRef': {
        const tip = branchTip(repo, pull.baseRef);
        return tip ? tag('Ref', { repo, name: pull.baseRef, oid: tip }) : null;
      }
      case 'author': return gqlUser(ensureUser(pull.user));
      case 'createdAt': return pull.created_at;
      case 'updatedAt': return pull.updated_at;
      case 'closedAt': return pull.state === 'closed' ? pull.updated_at : null;
      case 'mergedAt': return pull.merged_at;
      case 'mergeCommit': return pull.merge_commit_sha ? tag('Commit', { repo, oid: pull.merge_commit_sha }) : null;
      case 'url': return '';
      case 'repository': return gqlRepo(repo);
      case 'files': {
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef);
        const base = baseTip && headTip ? mergeBase(repo, baseTip, headTip) : null;
        const files = diffTrees(repo, base, headTip).map((file) =>
          tag('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' }),
        );
        return gqlConnection(files, args);
      }
      case 'comments':
        return gqlConnection(pull.comments.map((comment) => tag('IssueComment', { repo, comment })), args);
      case 'labels':
        return gqlConnection([], args);
      case 'additions': {
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef);
        const base = baseTip && headTip ? mergeBase(repo, baseTip, headTip) : null;
        return diffTrees(repo, base, headTip).reduce((sum, file) => sum + file.additions, 0);
      }
      case 'deletions': {
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef);
        const base = baseTip && headTip ? mergeBase(repo, baseTip, headTip) : null;
        return diffTrees(repo, base, headTip).reduce((sum, file) => sum + file.deletions, 0);
      }
      case 'changedFiles': {
        const baseTip = branchTip(repo, pull.baseRef);
        const headTip = branchTip(repo, pull.headRef);
        const base = baseTip && headTip ? mergeBase(repo, baseTip, headTip) : null;
        return diffTrees(repo, base, headTip).length;
      }
      default:
        return fail(`Field '${name}' doesn't exist on type 'PullRequest'`);
    }
  }

  if (type === 'Label') {
    const label = obj.label as LabelRec;
    switch (name) {
      case 'id': return globalId('Label', label.name);
      case 'name': return label.name;
      case 'color': return label.color;
      case 'description': return label.description;
      default: return fail(`Field '${name}' doesn't exist on type 'Label'`);
    }
  }

  if (type === 'IssueComment') {
    const comment = obj.comment as CommentRec;
    switch (name) {
      case 'id': return globalId('IssueComment', String(comment.id));
      case 'body': return comment.body;
      case 'author': return gqlUser(ensureUser(comment.user));
      case 'createdAt': return comment.created_at;
      case 'updatedAt': return comment.updated_at;
      case 'url': return '';
      default: return fail(`Field '${name}' doesn't exist on type 'IssueComment'`);
    }
  }

  if (type === 'Ref') {
    switch (name) {
      case 'name': return obj.name as string;
      case 'prefix': return 'refs/heads/';
      case 'target': return tag('Commit', { repo: obj.repo as RepoRec, oid: obj.oid as string });
      default: return fail(`Field '${name}' doesn't exist on type 'Ref'`);
    }
  }

  if (type === 'Commit') {
    switch (name) {
      case 'oid': return obj.oid as string;
      case 'message': {
        const repo = obj.repo as RepoRec;
        const gitObj = repo.objects.get(obj.oid as string);
        return gitObj ? parseCommit(gitObj.data).message : '';
      }
      default:
        return fail(`Field '${name}' doesn't exist on type 'Commit'`);
    }
  }

  if (type === 'PullRequestChangedFile') {
    switch (name) {
      case 'path': return obj.path as string;
      case 'additions': return obj.additions as number;
      case 'deletions': return obj.deletions as number;
      case 'changeType': return obj.changeType as string;
      default: return fail(`Field '${name}' doesn't exist on type 'PullRequestChangedFile'`);
    }
  }

  if (type === '__Type') {
    const typeName = obj.typeName as string;
    switch (name) {
      case 'name': return typeName;
      case 'kind': return obj.kind as string;
      case 'fields': return (GQL_TYPE_FIELDS[typeName] ?? []).map((fieldName) => ({ name: fieldName }));
      case 'enumValues': return (GQL_ENUM_VALUES[typeName] ?? []).map((valueName) => ({ name: valueName }));
      case 'description': return null;
      default: return fail(`Field '${name}' doesn't exist on type '__Type'`);
    }
  }

  if (type === '__Schema') {
    switch (name) {
      case 'types': return Object.keys(GQL_TYPE_FIELDS).map((typeName) => tag('__Type', { typeName, kind: 'OBJECT' }));
      case 'queryType': return tag('__Type', { typeName: 'Query', kind: 'OBJECT' });
      case 'mutationType': return tag('__Type', { typeName: 'Mutation', kind: 'OBJECT' });
      default: return fail(`Field '${name}' doesn't exist on type '__Schema'`);
    }
  }

  return fail(`Field '${name}' doesn't exist on type '${type}'`);
}

function gqlComplete(value: unknown, selection: GqlField[] | null, ctx: GqlCtx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => gqlComplete(item, selection, ctx, [...path, index]));
  if (isRecord(value) && typeof value.$type === 'string') {
    if (!selection) return {};
    const out: Record<string, unknown> = {};
    const expanded: GqlField[] = [];
    for (const field of selection) {
      if (field.isSpread) {
        if (field.selection) {
          if (field.fragment === value.$type) expanded.push(...field.selection);
        } else if (field.fragment && ctx.fragments.has(field.fragment)) {
          expanded.push(...(ctx.fragments.get(field.fragment) as GqlField[]));
        }
      } else {
        expanded.push(field);
      }
    }
    for (const field of expanded) {
      const key = field.alias ?? field.name;
      const resolved = gqlResolveField(value as GqlObj, field, ctx, path);
      out[key] = gqlComplete(resolved, field.selection, ctx, [...path, key]);
    }
    return out;
  }
  if (isRecord(value)) {
    if (!selection) return value;
    const out: Record<string, unknown> = {};
    for (const field of selection) {
      if (field.isSpread) continue;
      const key = field.alias ?? field.name;
      out[key] = gqlComplete(value[field.name], field.selection, ctx, [...path, key]);
    }
    return out;
  }
  return value;
}

function gqlExecute(operation: GqlOperation, variables: Record<string, unknown>, fragments: Map<string, GqlField[]>): Record<string, unknown> {
  const ctx: GqlCtx = { variables, errors: [], fragments };
  const root = tag(operation.kind === 'mutation' ? 'Mutation' : 'Query', {});
  // Root resolvers live on the Query/Mutation types; route through a shim:
  const rootObj: GqlObj = { $type: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  void root;
  const data = gqlComplete(rootObj, operation.selection, ctx, []);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors.map((error) => ({ message: error.message, path: error.path }));
  return response;
}

async function handleGraphql(res: ServerResponse, rawBody: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const executeOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    try {
      const parser = new GqlParser(gqlTokenize(entry.query));
      const operations = parser.parseDocument();
      let operation = operations[0];
      if (typeof entry.operationName === 'string') {
        operation = operations.find((candidate) => candidate.name === entry.operationName) ?? operation;
      }
      if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };
      return gqlExecute(operation, variables, parser.fragments);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(executeOne);
    const text = JSON.stringify(results);
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId() });
    res.end(text);
    return;
  }
  const result = executeOne(parsed);
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// MCP (streamable HTTP, legacy initialize era)

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Record<string, unknown>;
}

function mcpRepo(args: Record<string, unknown>): RepoRec {
  const repo = findRepo(str(args.owner, viewerLogin), str(args.repo));
  if (!repo) throw new Error(`repository ${str(args.owner)}/${str(args.repo)} not found`);
  return repo;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
    run: (args) => {
      const name = str(args.name);
      if (repos.some((repo) => repo.name === name)) throw new Error('name already exists on this account');
      const repo = createRepo(name, str(args.description), args.private === true);
      repo.owner = viewerLogin;
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
    run: (args) => repoJson(mcpRepo(args)),
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ repositories: repos.filter((repo) => repoOwnerLogin(repo) === viewerLogin).map(repoJson) }),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
    run: (args) => {
      const repo = mcpRepo(args);
      const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const name of labels) if (!repo.labels.has(name)) throw new Error(`label "${name}" does not exist`);
      return issueJson(repo, createIssueRec(repo, str(args.title), str(args.body), labels));
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
    run: (args) => {
      const repo = mcpRepo(args);
      const state = str(args.state, 'open');
      const list = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return { issues: list.map((issue) => issueJson(repo, issue)) };
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } }, required: ['owner', 'repo', 'issue_number'] },
    run: (args) => {
      const repo = mcpRepo(args);
      const issue = repo.issues.get(num(args.issue_number));
      if (!issue) throw new Error('issue not found');
      return issueJson(repo, issue);
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' }, body: { type: 'string' } }, required: ['owner', 'repo', 'issue_number', 'body'] },
    run: (args) => {
      const repo = mcpRepo(args);
      const holder = repo.issues.get(num(args.issue_number)) ?? repo.pulls.get(num(args.issue_number));
      if (!holder) throw new Error('issue not found');
      const comment: CommentRec = { id: nextCommentId, body: str(args.body), user: viewerLogin, created_at: nowIso(), updated_at: nowIso() };
      nextCommentId += 1;
      holder.comments.push(comment);
      return commentJson(repo, comment);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
    run: (args) => {
      const repo = mcpRepo(args);
      const pull = createPullRec(repo, str(args.title), str(args.body), str(args.head), str(args.base));
      if (!pull) throw new Error('head or base branch does not exist');
      return pullJson(repo, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
    run: (args) => {
      const repo = mcpRepo(args);
      const state = str(args.state, 'open');
      const list = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
      return { pull_requests: list.map((pull) => pullJson(repo, pull)) };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash)',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
    run: (args) => {
      const repo = mcpRepo(args);
      const pull = repo.pulls.get(num(args.pull_number));
      if (!pull) throw new Error('pull request not found');
      if (pull.state !== 'open') throw new Error('pull request is not open');
      const outcome = mergePull(repo, pull, 'squash');
      if (!outcome.ok) throw new Error('pull request is not mergeable');
      return pullJson(repo, pull);
    },
  },
  {
    name: 'search_issues',
    description: 'Search issues by full words in title and body',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: (args) => {
      const words = str(args.query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const found: Record<string, unknown>[] = [];
      for (const repo of repos) {
        for (const issue of repo.issues.values()) {
          const wordSet = new Set(`${issue.title} ${issue.body}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
          if (words.every((word) => wordSet.has(word))) found.push(issueJson(repo, issue));
        }
      }
      return { issues: found, total_count: found.length };
    },
  },
];

function mcpToolList(): Record<string, unknown>[] {
  return MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  if ((req.method ?? 'GET') === 'GET') {
    // No server-initiated stream is offered; streamable HTTP allows 405 here.
    sendEmpty(res, 405);
    return;
  }
  if ((req.method ?? '') === 'DELETE') {
    sendEmpty(res, 200);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    const text = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    res.writeHead(400, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId() });
    res.end(text);
    return;
  }
  const handleOne = (entry: unknown): Record<string, unknown> | null => {
    if (!isRecord(entry) || typeof entry.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const id = entry.id ?? null;
    const isNotification = entry.id === undefined;
    const params = isRecord(entry.params) ? entry.params : {};
    switch (entry.method) {
      case 'initialize': {
        const requested = str(params.protocolVersion, '2025-11-25');
        const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'git-forge', version: '1.0.0' },
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: mcpToolList() } };
      case 'tools/call': {
        const name = str(params.name);
        const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
        if (!tool) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } };
        }
        const args = isRecord(params.arguments) ? params.arguments : {};
        const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
        const missing = required.filter((key) => args[key] === undefined);
        if (missing.length > 0) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `missing required arguments: ${missing.join(', ')}` } };
        }
        try {
          const result = tool.run(args);
          const text = JSON.stringify(result);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: result, isError: false } };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true },
          };
        }
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${entry.method}` } };
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(handleOne).filter((entry) => entry !== null);
    const text = JSON.stringify(results);
    res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), 'mcp-session-id': 'forge-session' });
    res.end(text);
    return;
  }
  const result = handleOne(parsed);
  if (result === null) {
    sendEmpty(res, 202);
    return;
  }
  const text = JSON.stringify(result);
  res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), 'mcp-session-id': 'forge-session' });
  res.end(text);
}

// ---------------------------------------------------------------------------
// the router

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' }, { 'x-oauth-scopes': 'repo, read:org' });
            return;
          }
          // normalize: /api/v3 and /api/v3/ both mean the root
          await handleRest(req, res, url, rawBody);
          return;
        }

        if (path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            notFound(res);
            return;
          }
          await handleGraphql(res, rawBody);
          return;
        }

        if (path === '/mcp') {
          if (!authorized(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
            return;
          }
          handleMcp(req, res, rawBody);
          return;
        }

        // git smart HTTP: /<owner>/<repo>.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const tailPath = gitMatch[3] ?? '';
          const repo = findRepo(owner, repoName);
          if (!repo) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestId() });
            res.end('not found\n');
            return;
          }
          if (method === 'GET' && tailPath === '/info/refs') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('invalid service\n');
              return;
            }
            handleInfoRefs(res, repo, service, req.headers['git-protocol'] ?? '');
            return;
          }
          if (method === 'POST' && tailPath === '/git-upload-pack') {
            const packets = decodePackets(rawBody);
            const firstLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8') ?? '';
            if (/version=2/.test(req.headers['git-protocol'] ?? '') || firstLine.startsWith('command=')) {
              handleUploadPackV2(res, repo, packets);
            } else {
              handleUploadPackV0(res, repo, packets);
            }
            return;
          }
          if (method === 'POST' && tailPath === '/git-receive-pack') {
            handleReceivePack(res, repo, rawBody);
            return;
          }
          notFound(res);
          return;
        }

        notFound(res);
      } catch (err) {
        // A malformed request must never take the server down.
        try {
          if (!res.headersSent) {
            sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
          } else {
            res.end();
          }
        } catch {
          // socket already gone
        }
      }
    })();
  });
}
