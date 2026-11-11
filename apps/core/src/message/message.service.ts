import { Inject, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { Binary, Db, ObjectId } from 'mongodb';
import type Redis from 'ioredis';
import {
  encryptBusPayload,
  MAX_MESSAGE_LENGTH,
  MESSAGE_TTL_SECONDS,
  REACTION_EMOJIS,
  REPLY_PREVIEW_MAX,
  RmqRoutingKeys,
  type MessageView,
  type ReactionEmoji,
  type RoomReadMap,
  uuidToBytes,
  bytesToUuid,
  ErrorCodes,
  type ErrorCode,
} from '@anonyma/shared';
import { CryptoService } from '../crypto/crypto.service';
import { MONGO_DB } from '../mongo/mongo.module';
import { RoomService } from '../room/room.service';
import { RmqPublisherService } from '../rmq/rmq-publisher.service';
import { REDIS } from '@anonyma/nest-common';
import { SessionService } from '../session/session.service';
import { messagesWrittenTotal } from '../metrics/metrics';
import { toggleReaction } from './reactions';

/**
 * Errors must cross RabbitMQ as RpcException: Nest turns an HttpException thrown
 * in an RPC handler into a generic "Internal server error", which the gateway
 * answered as 500 "Upstream error" (e.g. replying to a message that had expired).
 */
function rpcError(statusCode: number, message: string, code: ErrorCode): never {
  throw new RpcException({ statusCode, message, code });
}

interface MessageDoc {
  _id: ObjectId;
  r: Binary;
  s: Binary; // author's session hash prefix (room pseudonym)
  sid?: Binary; // author's session UUID bytes (ownership)
  n: Binary;
  niv: Binary;
  c: Binary;
  iv: Binary;
  t: Date;
  replyTo?: ObjectId;
  rp?: Binary; // encrypted reply preview
  rpiv?: Binary;
  reactions?: Record<string, string[]>;
  /** Bumped on every reaction write; the write only lands if nobody wrote in between. */
  rv?: number;
  editedAt?: Date;
  deleted?: boolean;
}

@Injectable()
export class MessageService {
  constructor(
    @Inject(MONGO_DB) private readonly mongo: Db,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
    private readonly rooms: RoomService,
    private readonly sessions: SessionService,
    private readonly rmq: RmqPublisherService,
    private readonly config: ConfigService,
  ) {}

  private collection() {
    return this.mongo.collection<MessageDoc>('messages');
  }

  private ttlSeconds(): number {
    return Number(this.config.get('MESSAGE_TTL_SECONDS') ?? MESSAGE_TTL_SECONDS);
  }

  private busKey(): string {
    return this.config.getOrThrow<string>('MESSAGE_ENCRYPTION_KEY');
  }

  private readKey(roomId: string): string {
    return `readroom:${roomId}`;
  }

  private previewText(content: string): string {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= REPLY_PREVIEW_MAX) return trimmed;
    return `${trimmed.slice(0, REPLY_PREVIEW_MAX - 1)}…`;
  }

  private emptyReactions(): Record<string, string[]> {
    return {};
  }

  private docToView(doc: MessageDoc, roomId: string): MessageView {
    const ttl = this.ttlSeconds();
    const expiresAt = doc.t;
    const createdAt = new Date(expiresAt.getTime() - ttl * 1000);
    const deleted = Boolean(doc.deleted);
    const roomAad = Buffer.from(doc.r.buffer);
    let content = '';
    if (!deleted) {
      content = this.crypto.decryptMessage(
        Buffer.from(doc.c.buffer),
        Buffer.from(doc.iv.buffer),
        roomAad,
      );
    }
    const nickname = this.crypto.decryptMessage(
      Buffer.from(doc.n.buffer),
      Buffer.from(doc.niv.buffer),
      roomAad,
    );
    // Others see the sender's per-room pseudonym, never the session's lasting id.
    const senderSessionId = this.crypto.pseudonym(
      roomId,
      Buffer.from(doc.s.buffer).toString('hex'),
    );
    let replyPreview: string | undefined;
    if (doc.rp && doc.rpiv) {
      try {
        replyPreview = this.crypto.decryptMessage(
          Buffer.from(doc.rp.buffer),
          Buffer.from(doc.rpiv.buffer),
          roomAad,
        );
      } catch {
        replyPreview = undefined;
      }
    }
    return {
      id: doc._id.toHexString(),
      roomId,
      senderSessionId,
      nickname,
      content: deleted ? '' : content,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      replyToId: doc.replyTo?.toHexString(),
      replyPreview,
      reactions: doc.reactions ?? this.emptyReactions(),
      editedAt: doc.editedAt?.toISOString() ?? null,
      deleted,
    };
  }

  private async publishMessage(
    routingKey:
      | typeof RmqRoutingKeys.CHAT_MESSAGE_CREATED
      | typeof RmqRoutingKeys.CHAT_MESSAGE_UPDATED
      | typeof RmqRoutingKeys.CHAT_MESSAGE_DELETED,
    roomId: string,
    view: MessageView,
  ): Promise<void> {
    await this.rmq.publish(routingKey, {
      roomId,
      envelope: encryptBusPayload(view, this.busKey()),
    });
  }

  async send(input: {
    sessionToken: string;
    roomId: string;
    content: string;
    replyToId?: string;
  }): Promise<MessageView> {
    const content = input.content.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      rpcError(400, 'Invalid message length', ErrorCodes.MESSAGE_INVALID);
    }
    // Control characters on purpose: a message made of them is noise, not text.
    // eslint-disable-next-line no-control-regex
    if ((content.match(/[\u0000-\u001F]/g) ?? []).length > 20) {
      rpcError(400, 'Message rejected', ErrorCodes.MESSAGE_INVALID);
    }

    const member = await this.rooms.assertMembership(input.sessionToken, input.roomId);
    const ttl = this.ttlSeconds();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttl * 1000);
    const roomAad = this.crypto.roomIdToBinary(input.roomId);
    const { ciphertext, iv } = this.crypto.encryptMessage(content, roomAad);
    const nickEnc = this.crypto.encryptMessage(member.nickname, roomAad);

    let replyTo: ObjectId | undefined;
    let replyPreview: string | undefined;
    let rp: Binary | undefined;
    let rpiv: Binary | undefined;

    if (input.replyToId) {
      if (!ObjectId.isValid(input.replyToId)) {
        rpcError(400, 'Invalid reply target', ErrorCodes.MESSAGE_INVALID);
      }
      const parent = await this.collection().findOne({
        _id: new ObjectId(input.replyToId),
        r: new Binary(this.crypto.roomIdToBinary(input.roomId)),
        t: { $gt: new Date() },
      });
      if (!parent) {
        rpcError(400, 'Reply target not found', ErrorCodes.MESSAGE_NOT_FOUND);
      }
      replyTo = parent._id;
      if (parent.deleted) {
        replyPreview = 'Message deleted';
      } else {
        try {
          replyPreview = this.previewText(
            this.crypto.decryptMessage(
              Buffer.from(parent.c.buffer),
              Buffer.from(parent.iv.buffer),
              roomAad,
            ),
          );
        } catch {
          replyPreview = 'Message';
        }
      }
      const encPreview = this.crypto.encryptMessage(replyPreview, roomAad);
      rp = new Binary(encPreview.ciphertext);
      rpiv = new Binary(encPreview.iv);
    }

    const doc: Omit<MessageDoc, '_id'> = {
      r: new Binary(this.crypto.roomIdToBinary(input.roomId)),
      s: new Binary(Buffer.from(member.sessionHash.slice(0, 16), 'hex')),
      sid: new Binary(uuidToBytes(member.sessionId)),
      n: new Binary(nickEnc.ciphertext),
      niv: new Binary(nickEnc.iv),
      c: new Binary(ciphertext),
      iv: new Binary(iv),
      t: expiresAt,
      replyTo,
      rp,
      rpiv,
      reactions: {},
      deleted: false,
    };

    const result = await this.collection().insertOne(doc as MessageDoc);
    await this.rooms.touchEphemeralExpiry(input.roomId);

    const view: MessageView = {
      id: result.insertedId.toHexString(),
      roomId: input.roomId,
      senderSessionId: this.crypto.pseudonym(input.roomId, member.sessionHash),
      nickname: member.nickname,
      content,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      replyToId: replyTo?.toHexString(),
      replyPreview,
      reactions: {},
      editedAt: null,
      deleted: false,
    };

    await this.publishMessage(RmqRoutingKeys.CHAT_MESSAGE_CREATED, input.roomId, view);
    messagesWrittenTotal.inc({ op: 'send' });
    return view;
  }

  async list(
    sessionToken: string,
    roomId: string,
    limit = 50,
    before?: string,
  ): Promise<MessageView[]> {
    await this.rooms.assertMembership(sessionToken, roomId);
    const roomBin = new Binary(this.crypto.roomIdToBinary(roomId));
    const now = new Date();
    const filter: Record<string, unknown> = { r: roomBin, t: { $gt: now } };
    if (before && ObjectId.isValid(before)) {
      filter._id = { $lt: new ObjectId(before) };
    }
    const docs = await this.collection()
      .find(filter)
      .sort({ _id: -1 })
      .limit(Math.min(limit, 100))
      .toArray();

    return docs.map((doc) => this.docToView(doc, roomId)).reverse();
  }

  async edit(input: {
    sessionToken: string;
    messageId: string;
    content: string;
  }): Promise<MessageView> {
    const content = input.content.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) {
      rpcError(400, 'Invalid message length', ErrorCodes.MESSAGE_INVALID);
    }
    if (!ObjectId.isValid(input.messageId)) {
      rpcError(404, 'Message not found', ErrorCodes.MESSAGE_NOT_FOUND);
    }

    const session = await this.sessions.requireSession(input.sessionToken);
    const doc = await this.collection().findOne({
      _id: new ObjectId(input.messageId),
      t: { $gt: new Date() },
    });
    if (!doc) {
      rpcError(404, 'Message not found', ErrorCodes.MESSAGE_NOT_FOUND);
    }
    const roomId = this.crypto.binaryToRoomId(Buffer.from(doc.r.buffer));
    await this.rooms.assertMembership(input.sessionToken, roomId);
    this.assertOwner(doc, session.id);
    if (doc.deleted) {
      rpcError(400, 'Cannot edit a deleted message', ErrorCodes.MESSAGE_NOT_FOUND);
    }

    const roomAad = this.crypto.roomIdToBinary(roomId);
    const { ciphertext, iv } = this.crypto.encryptMessage(content, roomAad);
    const editedAt = new Date();
    const preview = this.previewText(content);
    const encPreview = this.crypto.encryptMessage(preview, roomAad);
    await this.collection().updateOne(
      { _id: doc._id },
      { $set: { c: new Binary(ciphertext), iv: new Binary(iv), editedAt } },
    );
    // Refresh reply previews that quote this message so edits (and later deletes) stay consistent.
    await this.collection().updateMany(
      { replyTo: doc._id, r: doc.r, t: { $gt: new Date() } },
      {
        $set: {
          rp: new Binary(encPreview.ciphertext),
          rpiv: new Binary(encPreview.iv),
        },
      },
    );
    const updated = await this.collection().findOne({ _id: doc._id });
    const view = this.docToView(updated!, roomId);
    view.content = content;
    view.editedAt = editedAt.toISOString();
    await this.rooms.touchEphemeralExpiry(roomId);
    await this.publishMessage(RmqRoutingKeys.CHAT_MESSAGE_UPDATED, roomId, view);
    // Fan out updated reply bubbles so live clients refresh quote text without reload.
    const replies = await this.collection()
      .find({ replyTo: doc._id, r: doc.r, t: { $gt: new Date() } })
      .limit(50)
      .toArray();
    for (const child of replies) {
      await this.publishMessage(
        RmqRoutingKeys.CHAT_MESSAGE_UPDATED,
        roomId,
        this.docToView(child, roomId),
      );
    }
    messagesWrittenTotal.inc({ op: 'edit' });
    return view;
  }

  async remove(input: { sessionToken: string; messageId: string }): Promise<MessageView> {
    if (!ObjectId.isValid(input.messageId)) {
      rpcError(404, 'Message not found', ErrorCodes.MESSAGE_NOT_FOUND);
    }
    const session = await this.sessions.requireSession(input.sessionToken);
    const doc = await this.collection().findOne({
      _id: new ObjectId(input.messageId),
      t: { $gt: new Date() },
    });
    if (!doc) {
      rpcError(404, 'Message not found', ErrorCodes.MESSAGE_NOT_FOUND);
    }
    const roomId = this.crypto.binaryToRoomId(Buffer.from(doc.r.buffer));
    await this.rooms.assertMembership(input.sessionToken, roomId);
    this.assertOwner(doc, session.id);

    const roomAad = this.crypto.roomIdToBinary(roomId);
    const placeholder = this.crypto.encryptMessage('', roomAad);
    const tombstonePreview = this.crypto.encryptMessage('Message deleted', roomAad);
    await this.collection().updateOne(
      { _id: doc._id },
      {
        $set: {
          deleted: true,
          c: new Binary(placeholder.ciphertext),
          iv: new Binary(placeholder.iv),
          reactions: {},
        },
        $unset: { rp: '', rpiv: '' },
      },
    );
    // Scrub reply-preview ciphertext that still holds the deleted body's plaintext under encryption.
    await this.collection().updateMany(
      { replyTo: doc._id, r: doc.r },
      {
        $set: {
          rp: new Binary(tombstonePreview.ciphertext),
          rpiv: new Binary(tombstonePreview.iv),
        },
      },
    );
    const updated = await this.collection().findOne({ _id: doc._id });
    const view = this.docToView(updated!, roomId);
    await this.publishMessage(RmqRoutingKeys.CHAT_MESSAGE_DELETED, roomId, view);
    const replies = await this.collection()
      .find({ replyTo: doc._id, r: doc.r, t: { $gt: new Date() } })
      .limit(50)
      .toArray();
    for (const child of replies) {
      await this.publishMessage(
        RmqRoutingKeys.CHAT_MESSAGE_UPDATED,
        roomId,
        this.docToView(child, roomId),
      );
    }
    messagesWrittenTotal.inc({ op: 'delete' });
    return view;
  }

  async react(input: {
    sessionToken: string;
    messageId: string;
    emoji: string;
  }): Promise<{ roomId: string; messageId: string; reactions: Record<string, string[]> }> {
    if (!REACTION_EMOJIS.includes(input.emoji as ReactionEmoji)) {
      rpcError(400, 'Invalid reaction', ErrorCodes.MESSAGE_INVALID);
    }
    if (!ObjectId.isValid(input.messageId)) {
      rpcError(404, 'Message not found', ErrorCodes.MESSAGE_NOT_FOUND);
    }

    const session = await this.sessions.requireSession(input.sessionToken);
    let roomId = '';
    let reactions: Record<string, string[]> = {};
    let membershipChecked = false;
    // Read, change, write back only if nobody wrote in between; two people reacting
    // at the same moment used to lose one of the reactions.
    for (let attempt = 0; ; attempt += 1) {
      const doc = await this.collection().findOne({
        _id: new ObjectId(input.messageId),
        t: { $gt: new Date() },
      });
      if (!doc || doc.deleted) {
        rpcError(404, 'Message not found', ErrorCodes.MESSAGE_NOT_FOUND);
      }
      roomId = this.crypto.binaryToRoomId(Buffer.from(doc.r.buffer));
      if (!membershipChecked) {
        await this.rooms.assertMembership(input.sessionToken, roomId);
        membershipChecked = true;
      }

      reactions = toggleReaction(
        doc.reactions ?? {},
        this.crypto.pseudonym(roomId, session.sessionHash),
        input.emoji,
      );
      const version = doc.rv ?? 0;
      const res = await this.collection().updateOne(
        { _id: doc._id, ...(version === 0 ? { rv: { $exists: false } } : { rv: version }) },
        { $set: { reactions, rv: version + 1 } },
      );
      if (res.matchedCount === 1) break;
      if (attempt >= 4) rpcError(409, 'Reaction conflict, try again', ErrorCodes.MESSAGE_CONFLICT);
    }
    const payload = { roomId, messageId: input.messageId, reactions };
    await this.rmq.publish(RmqRoutingKeys.CHAT_REACTION_UPDATED, {
      roomId,
      envelope: encryptBusPayload(payload, this.busKey()),
    });
    messagesWrittenTotal.inc({ op: 'react' });
    return payload;
  }

  async markRead(input: {
    sessionToken: string;
    roomId: string;
    messageId: string;
  }): Promise<{ roomId: string; sessionId: string; messageId: string; reads: RoomReadMap }> {
    if (!ObjectId.isValid(input.messageId)) {
      rpcError(400, 'Invalid message id', ErrorCodes.INVALID_ID);
    }
    const member = await this.rooms.assertMembership(input.sessionToken, input.roomId);
    const doc = await this.collection().findOne({
      _id: new ObjectId(input.messageId),
      r: new Binary(this.crypto.roomIdToBinary(input.roomId)),
      t: { $gt: new Date() },
    });
    if (!doc) {
      rpcError(404, 'Message not found', ErrorCodes.MESSAGE_NOT_FOUND);
    }

    const key = this.readKey(input.roomId);
    // Read receipts are keyed by the reader's per-room pseudonym.
    const readerId = this.crypto.pseudonym(input.roomId, member.sessionHash);
    const prev = await this.redis.hget(key, readerId);
    if (prev && prev >= input.messageId) {
      const reads = await this.listReads(input.roomId);
      return { roomId: input.roomId, sessionId: readerId, messageId: prev, reads };
    }

    const ttl = this.ttlSeconds();
    await this.redis.hset(key, readerId, input.messageId);
    await this.redis.expire(key, ttl);
    const reads = await this.listReads(input.roomId);
    const payload = {
      roomId: input.roomId,
      sessionId: readerId,
      messageId: input.messageId,
      reads,
    };
    await this.rmq.publish(RmqRoutingKeys.CHAT_READ_UPDATED, {
      roomId: input.roomId,
      envelope: encryptBusPayload(payload, this.busKey()),
    });
    return payload;
  }

  async listReadsForMember(sessionToken: string, roomId: string): Promise<RoomReadMap> {
    await this.rooms.assertMembership(sessionToken, roomId);
    return this.listReads(roomId);
  }

  private async listReads(roomId: string): Promise<RoomReadMap> {
    const raw = await this.redis.hgetall(this.readKey(roomId));
    return raw ?? {};
  }

  /**
   * Every stored message carries its author's session id (`sid`); messages live
   * ten minutes, so none from before that field are left to match by hash.
   */
  private assertOwner(doc: MessageDoc, sessionId: string): void {
    if (doc.sid && doc.sid.length() === 16) {
      const sid = bytesToUuid(Buffer.from(doc.sid.buffer));
      if (sid === sessionId) return;
    }
    // RpcException keeps status across RMQ (HttpException collapses to 500 on gateway).
    throw new RpcException({
      statusCode: 403,
      message: 'Not message owner',
      code: ErrorCodes.NOT_MESSAGE_OWNER,
    });
  }
}
