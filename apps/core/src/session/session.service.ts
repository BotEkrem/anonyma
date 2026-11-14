import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { and, eq, gt } from 'drizzle-orm';
import {
  ErrorCodes,
  SESSION_TTL_SECONDS,
  type AnonymousSessionView,
  RmqRoutingKeys,
} from '@anonyma/shared';
import { CryptoService } from '../crypto/crypto.service';
import { DRIZZLE, type DrizzleDb } from '../db/database.module';
import { anonymousSessions } from '../db/schema';
import { RmqPublisherService } from '../rmq/rmq-publisher.service';

function rpcUnauthorized(message: string): never {
  throw new RpcException({ statusCode: 401, message, code: ErrorCodes.SESSION_INVALID });
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly rmq: RmqPublisherService,
  ) {}

  async createSession(): Promise<{ token: string; view: AnonymousSessionView }> {
    const token = this.crypto.createSessionToken();
    const sessionHash = this.crypto.hashSessionToken(token);
    const ttl = Number(this.config.get('SESSION_TTL_SECONDS') ?? SESSION_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const [row] = await this.db
      .insert(anonymousSessions)
      .values({ sessionHash, expiresAt })
      .returning();

    const view: AnonymousSessionView = {
      id: row!.id,
      createdAt: row!.createdAt.toISOString(),
      expiresAt: row!.expiresAt.toISOString(),
    };

    await this.rmq.publish(RmqRoutingKeys.SESSION_CREATED, {
      sessionId: row!.id,
      expiresAt: view.expiresAt,
    });

    return { token, view };
  }

  async requireSession(token: string): Promise<{ id: string; sessionHash: string }> {
    if (!token) {
      rpcUnauthorized('Missing session');
    }
    const sessionHash = this.crypto.hashSessionToken(token);
    const [row] = await this.db
      .select()
      .from(anonymousSessions)
      .where(
        and(
          eq(anonymousSessions.sessionHash, sessionHash),
          gt(anonymousSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!row) {
      rpcUnauthorized('Invalid or expired session');
    }

    return { id: row.id, sessionHash: row.sessionHash };
  }

  async getSessionView(token: string): Promise<AnonymousSessionView> {
    const session = await this.requireSession(token);
    const ttl = Number(this.config.get('SESSION_TTL_SECONDS') ?? SESSION_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    // Sliding renewal so active users are not kicked mid-chat.
    await this.db
      .update(anonymousSessions)
      .set({ expiresAt })
      .where(eq(anonymousSessions.id, session.id));
    const [row] = await this.db
      .select()
      .from(anonymousSessions)
      .where(eq(anonymousSessions.id, session.id))
      .limit(1);

    return {
      id: row!.id,
      createdAt: row!.createdAt.toISOString(),
      expiresAt: row!.expiresAt.toISOString(),
    };
  }

  async deleteSession(token: string): Promise<void> {
    if (!token) {
      return;
    }
    const sessionHash = this.crypto.hashSessionToken(token);
    await this.db.delete(anonymousSessions).where(eq(anonymousSessions.sessionHash, sessionHash));
  }
}
